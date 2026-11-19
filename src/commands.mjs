import { ApiError, PERMISSIONS, effectivePermissions, isTextChannel, validateAttachment } from './discord.mjs';
import { assertId } from './store.mjs';

function fail(message) { throw new ApiError(message); }
function has(bits, permission) { return (bits & permission) === permission; }

function optionsOf(options) {
  if (!Array.isArray(options ?? [])) fail('The command options are invalid. Register the latest commands.');
  const result = new Map();
  for (const item of options ?? []) {
    if (typeof item?.name !== 'string' || result.has(item.name)) fail('The command options are invalid.');
    result.set(item.name, item.value);
  }
  return result;
}

export function parseCommand(interaction) {
  const data = interaction.data;
  if (data?.name === 'post') return { name: 'post', options: optionsOf(data.options) };
  if (data?.name === 'settings' && data.options?.length === 1) {
    const command = data.options[0];
    if (command.type === 1 && ['channels', 'add', 'remove', 'list', 'clear'].includes(command.name)) {
      return { name: 'settings/' + command.name, options: optionsOf(command.options) };
    }
  }
  fail('Unknown command. Register this version of the slash commands.');
}

function optionId(options, name) {
  try { return assertId(options.get(name)); } catch { fail(`Select a valid ${name} in the command picker.`); }
}

function channelPermissions(context, channel, member = context.bot) {
  return effectivePermissions(context.guild, context.roles, member, channel);
}

function requireChannel(context, channel, { posting = false } = {}) {
  if (!isTextChannel(channel, context.guild.id)) fail('Choose a normal text channel in the configured server; threads and forum posts are not supported.');
  if (!has(channelPermissions(context, channel, context.actor), PERMISSIONS.VIEW_CHANNEL)) fail('Choose a channel your controller account can see.');
  const required = PERMISSIONS.VIEW_CHANNEL | PERMISSIONS.SEND_MESSAGES | (posting ? PERMISSIONS.ATTACH_FILES : 0n);
  if (!has(channelPermissions(context, channel), required)) {
    fail(posting
      ? 'Give the bot View Channel, Send Messages, and Attach Files in the saved post channel.'
      : 'Give the bot View Channel and Send Messages in the command channel.');
  }
}

async function loadContext(interaction, env, store, api, command) {
  const settings = await store.getSettings();
  const configured = Boolean(settings.commandChannelId && settings.postChannelId);
  if (!configured && command.name !== 'settings/channels') {
    fail('Choose both channels first: /settings channels command_channel:#bot-control post_channel:#photos.');
  }
  if (configured && interaction.channel_id !== settings.commandChannelId) fail('Use this bot\'s configured command channel.');
  const [guild, roles, actor, self, origin] = await Promise.all([
    api.getGuild(env.DISCORD_GUILD_ID),
    api.getRoles(env.DISCORD_GUILD_ID),
    api.getMember(env.DISCORD_GUILD_ID, env.CONTROLLER_USER_ID),
    api.request('GET', '/users/@me'),
    api.getChannel(interaction.channel_id),
  ]);
  if (guild.id !== env.DISCORD_GUILD_ID || actor.user?.id !== env.CONTROLLER_USER_ID || !Array.isArray(roles)) {
    fail('Discord returned an unexpected server or controller account.');
  }
  const basePermissions = effectivePermissions(guild, roles, actor, { permission_overwrites: [] });
  if (!has(basePermissions, PERMISSIONS.ADMINISTRATOR)) {
    fail('Your controller account must still own the server or have Administrator permission.');
  }
  const bot = await api.getMember(env.DISCORD_GUILD_ID, assertId(self.id));
  const context = { guild, roles, actor, bot, origin, settings, store, api, env, interaction };
  requireChannel(context, origin);
  return context;
}

function classifyTarget(context, value) {
  let targetId;
  try { targetId = assertId(value); } catch { fail('Select a person or role from the target picker.'); }
  const isRole = context.roles.some(role => role.id === targetId)
    || Object.hasOwn(context.interaction.data.resolved?.roles ?? {}, targetId);
  if (isRole && targetId === context.guild.id) fail('Choose a server role other than @everyone.');
  return { kind: isRole ? 'role' : 'user', id: targetId };
}

async function configureChannels(context, options) {
  const commandId = optionId(options, 'command_channel');
  const postId = optionId(options, 'post_channel');
  if (commandId === postId) fail('The command channel and post channel must be different.');
  const [commandChannel, postChannel] = await Promise.all([
    context.api.getChannel(commandId), context.api.getChannel(postId),
  ]);
  requireChannel(context, commandChannel);
  requireChannel(context, postChannel, { posting: true });
  await context.store.setChannels(commandId, postId);
  return { content: `Saved. Run your commands in <#${commandId}>. Every /post sends only to <#${postId}>.` };
}

async function addTarget(context, options) {
  const target = classifyTarget(context, options.get('target'));
  if (target.kind === 'role') {
    if (!context.roles.some(role => role.id === target.id)) fail('That role is no longer in the server.');
  } else {
    const member = await context.api.getMember(context.guild.id, target.id);
    if (member.user?.id !== target.id) fail('That user is no longer in the server.');
  }
  const result = await context.store.addTarget(target);
  if (result === 'exists') return { content: 'That target is already saved. Use /settings list to see the automatic pings.' };
  if (result === 'limit') fail('You can save up to 25 users and roles combined. Remove one first.');
  const mention = target.kind === 'role' ? `<@&${target.id}>` : `<@${target.id}>`;
  return { content: `Saved ${mention}. Every /post will include this target.` };
}

async function removeTarget(context, options) {
  const target = options.get('target');
  const targetId = options.get('target_id');
  if ((target === undefined) === (targetId === undefined)) fail('Choose either target or target_id to remove one saved ping.');
  let selected;
  if (target !== undefined) selected = classifyTarget(context, target);
  else {
    try { selected = assertId(String(targetId).trim()); } catch { fail('Use a numeric target_id from /settings list.'); }
  }
  const removed = await context.store.removeTarget(selected);
  return { content: removed ? 'Removed that target from automatic pings.' : 'That target is not in the saved list.' };
}

function listTargets(context) {
  const saved = context.settings;
  const lines = [
    `Command channel: <#${saved.commandChannelId}>`,
    `Post channel: <#${saved.postChannelId}>`, '',
    'Saved automatic pings (included on every /post):',
  ];
  if (!saved.targets.length) lines.push('None yet. Use /settings add target:@someone or target:@role.');
  for (const target of saved.targets) {
    const mention = target.kind === 'role' ? `<@&${target.id}>` : `<@${target.id}>`;
    lines.push(`- ${mention} — ${target.kind} ID: ${target.id}`);
  }
  return { content: lines.join('\n') };
}

async function postPhoto(context, options) {
  // The command schema has no channel option, and crafted overrides are rejected.
  if ([...options.keys()].some(name => !['photo', 'target', 'caption'].includes(name))) fail('The post destination is fixed. Register the latest commands.');
  const attachmentId = optionId(options, 'photo');
  const attachment = validateAttachment(context.interaction.data.resolved?.attachments?.[attachmentId]);
  if (attachment.id !== attachmentId) fail('Upload the image directly in the /post photo field.');
  let caption = options.get('caption') ?? '';
  if (typeof caption !== 'string') fail('The caption must be text.');
  caption = caption.trim();
  if (caption.length > 1800) fail('Keep the caption at 1800 characters or fewer.');
  const targets = [...context.settings.targets];
  if (options.has('target')) {
    const extra = classifyTarget(context, options.get('target'));
    if (!targets.some(item => item.kind === extra.kind && item.id === extra.id)) targets.push(extra);
  }
  if (!targets.length) fail('Save users or roles with /settings add, or choose a target for this photo.');
  const postId = context.settings.postChannelId;
  if (postId === context.settings.commandChannelId) fail('Choose separate channels using /settings channels.');
  const destination = await context.api.getChannel(postId);
  requireChannel(context, destination, { posting: true });
  if (destination.id !== postId) fail('The saved post channel is unavailable. Update /settings channels.');
  const botPermissions = channelPermissions(context, destination);
  const users = [];
  const roles = [];
  const mentions = [];
  for (const target of targets) {
    if (target.kind === 'role') {
      const role = context.roles.find(item => item.id === target.id);
      if (!role || role.id === context.guild.id) fail(`Saved role ${target.id} is unavailable. Remove it with /settings remove target_id:${target.id}.`);
      if (!role.mentionable && !has(botPermissions, PERMISSIONS.MENTION_EVERYONE)) {
        fail(`Role ${target.id} is not mentionable. Make it mentionable or grant the bot 'Mention @everyone, @here, and All Roles' in the post channel.`);
      }
      roles.push(target.id);
      mentions.push(`<@&${target.id}>`);
    } else {
      let member;
      try {
        member = target.id === context.actor.user.id ? context.actor
          : target.id === context.bot.user.id ? context.bot
          : await context.api.getMember(context.guild.id, target.id);
      } catch (error) {
        if (error.status === 404) fail(`Saved user ${target.id} left the server. Remove it with /settings remove target_id:${target.id}.`);
        throw error;
      }
      if (member.user?.id !== target.id) fail('Discord returned an unexpected target user.');
      if (!has(channelPermissions(context, destination, member), PERMISSIONS.VIEW_CHANNEL)) {
        fail(`Person ${target.id} cannot see the post channel. Update /settings channels or remove that saved ping.`);
      }
      users.push(target.id);
      mentions.push(`<@${target.id}>`);
    }
  }
  const content = mentions.join(' ') + (caption ? '\n' + caption : '');
  if (content.length > 2000) fail('The pings and caption exceed 2000 characters. Shorten the caption or remove some saved pings.');
  const sent = await context.api.sendPhoto(postId, {
    content, allowed_mentions: { parse: [], users, roles, replied_user: false },
    nonce: context.interaction.id, attachment,
  });
  return {
    messageId: sent.id,
    content: `Posted! [Open the photo](https://discord.com/channels/${context.guild.id}/${postId}/${sent.id})`,
  };
}

export async function executeCommand(interaction, env, store, api) {
  const command = parseCommand(interaction);
  const context = await loadContext(interaction, env, store, api, command);
  switch (command.name) {
    case 'settings/channels': return configureChannels(context, command.options);
    case 'settings/add': return addTarget(context, command.options);
    case 'settings/remove': return removeTarget(context, command.options);
    case 'settings/list': return listTargets(context);
    case 'settings/clear':
      await store.clearTargets();
      return { content: 'Cleared all automatic pings. Your channels are unchanged.' };
    case 'post': return postPhoto(context, command.options);
    default: fail('Unknown command.');
  }
}
