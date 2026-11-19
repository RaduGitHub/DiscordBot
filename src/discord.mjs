/** Discord REST, permissions and streamed image transfers; no Gateway connection. */

export const MAX_PHOTO_BYTES = 25 * 1024 * 1024;
export const IMAGE_TYPES = new Set(["image/jpeg", "image/png", "image/gif", "image/webp"]);
export const PERMISSIONS = Object.freeze({
  ADMINISTRATOR: 1n << 3n,
  VIEW_CHANNEL: 1n << 10n,
  SEND_MESSAGES: 1n << 11n,
  ATTACH_FILES: 1n << 15n,
  MENTION_EVERYONE: 1n << 17n,
  USE_APPLICATION_COMMANDS: 1n << 31n,
});
const ALL_PERMISSIONS = (1n << 64n) - 1n;
const API_BASE = "https://discord.com/api/v10";
const CDN_HOSTS = new Set(["cdn.discordapp.com", "media.discordapp.net"]);
const encoder = new TextEncoder();
const MAX_ID = (1n << 64n) - 1n;

export class ApiError extends Error {
  constructor(userMessage, { status = 0, code = null, retryAfter = 0, ambiguous = false } = {}) {
    super(userMessage);
    this.name = "ApiError";
    this.userMessage = userMessage;
    this.status = Number.isInteger(status) ? status : 0;
    this.code = Number.isInteger(code) ? code : null;
    this.retryAfter = Number.isFinite(retryAfter) ? Math.max(0, Math.min(retryAfter, 900)) : 0;
    this.ambiguous = Boolean(ambiguous);
  }
}

function id(value) {
  const text = String(value ?? "");
  if (!/^[1-9][0-9]{0,19}$/.test(text) || BigInt(text) > MAX_ID) {
    throw new ApiError("Discord supplied an invalid user, role, channel, or attachment ID.");
  }
  return text;
}

function bits(value) {
  try {
    if (!/^[0-9]+$/.test(String(value ?? ""))) return 0n;
    return BigInt(value);
  } catch {
    return 0n;
  }
}

/** Discord's documented everyone -> roles -> member overwrite ordering. */
export function effectivePermissions(guild, roles, member, channel) {
  const userId = String(member?.user?.id ?? member?.id ?? "");
  if (userId && userId === String(guild?.owner_id ?? "")) return ALL_PERMISSIONS;
  const guildId = String(guild?.id ?? "");
  const memberRoles = new Set((member?.roles ?? []).map(String));
  let permissions = 0n;
  for (const role of roles ?? []) {
    if (String(role.id) === guildId || memberRoles.has(String(role.id))) permissions |= bits(role.permissions);
  }
  if (permissions & PERMISSIONS.ADMINISTRATOR) return ALL_PERMISSIONS;
  const overwrites = channel?.permission_overwrites ?? [];
  const everyone = overwrites.find((overwrite) => Number(overwrite.type) === 0 && String(overwrite.id) === guildId);
  if (everyone) permissions = (permissions & ~bits(everyone.deny)) | bits(everyone.allow);
  let denied = 0n;
  let allowed = 0n;
  for (const overwrite of overwrites) {
    if (Number(overwrite.type) === 0 && String(overwrite.id) !== guildId && memberRoles.has(String(overwrite.id))) {
      denied |= bits(overwrite.deny);
      allowed |= bits(overwrite.allow);
    }
  }
  permissions = (permissions & ~denied) | allowed;
  const personal = overwrites.find((overwrite) => Number(overwrite.type) === 1 && String(overwrite.id) === userId);
  if (personal) permissions = (permissions & ~bits(personal.deny)) | bits(personal.allow);
  return permissions;
}

export function isTextChannel(channel, guildId) {
  return Boolean(channel && [0, 5].includes(channel.type) && String(channel.guild_id) === String(guildId));
}

function cleanFilename(filename, mime, attachmentId) {
  const extensions = { "image/jpeg": ".jpg", "image/png": ".png", "image/gif": ".gif", "image/webp": ".webp" };
  const original = typeof filename === "string" ? filename : "";
  const spoiler = original.startsWith("SPOILER_");
  let clean = original
    .replace(/[\x00-\x1f\x7f"\\/;]/g, "_")
    .replace(/[^\x20-\x7e]/g, "_")
    .slice(0, 140)
    .replace(/^\.+/, "");
  if (!clean || !/[a-z0-9]/i.test(clean)) clean = "photo-" + attachmentId;
  const accepted = mime === "image/jpeg" ? /\.jpe?g$/i : new RegExp("\\" + extensions[mime] + "$", "i");
  if (!accepted.test(clean)) clean = clean.replace(/\.(?:jpe?g|png|gif|webp)$/i, "") + extensions[mime];
  if (spoiler && !clean.startsWith("SPOILER_")) clean = "SPOILER_" + clean;
  return clean;
}

/** Only resolved Discord attachments are accepted; arbitrary URLs are never fetched. */
export function validateAttachment(attachment) {
  if (!attachment || typeof attachment !== "object") throw new ApiError("Attach a JPG, PNG, GIF, or WebP image to /post.");
  const attachmentId = id(attachment.id);
  const mime = String(attachment.content_type ?? "").split(";", 1)[0].toLowerCase();
  if (!IMAGE_TYPES.has(mime)) throw new ApiError("Please upload a JPG, PNG, GIF, or WebP image.");
  if (!Number.isSafeInteger(attachment.size) || attachment.size <= 0 || attachment.size > MAX_PHOTO_BYTES) {
    throw new ApiError("Use an image no larger than 25 MiB and within your server's upload limit.");
  }
  let url;
  try { url = new URL(attachment.url); } catch { throw new ApiError("The attachment link is invalid. Upload the image again with /post."); }
  const path = /^\/(?:ephemeral-)?attachments\/([0-9]+)\/([0-9]+)\/[^/]+$/.exec(url.pathname);
  if (url.protocol !== "https:" || !CDN_HOSTS.has(url.hostname) || url.username || url.password ||
      url.port || url.hash || !path || path[2] !== attachmentId) {
    throw new ApiError("Use an image uploaded directly in the /post attachment field.");
  }
  return {
    ...attachment,
    id: attachmentId,
    content_type: mime,
    filename: cleanFilename(attachment.filename, mime, attachmentId),
    url: url.href,
  };
}

function mentions(value) {
  const users = [...new Set((value?.users ?? []).map(id))];
  const roles = [...new Set((value?.roles ?? []).map(id))];
  if (users.length > 100 || roles.length > 100) throw new ApiError("Too many mention targets were selected.");
  return { parse: [], users, roles, replied_user: false };
}

async function parseResponse(response, ambiguous = false) {
  let result;
  try { result = await response.json(); } catch { result = null; }
  if (!response.ok) {
    const retry = Number(result?.retry_after ?? response.headers?.get("retry-after") ?? 0);
    let message = "Discord could not complete the request. Try again later.";
    if (response.status === 401) message = "Discord rejected the bot token. Check the Cloudflare secret.";
    if (response.status === 403) message = "Discord denied access. Check the bot's channel permissions.";
    if (response.status === 404) message = "A Discord user, role, channel, or response is no longer available.";
    if (response.status === 413 || result?.code === 40005) message = "Discord rejected the image size. Try a smaller photo.";
    if (response.status === 429) message = "Discord is rate limiting the bot. Wait before trying again.";
    throw new ApiError(message, { status: response.status, code: result?.code, retryAfter: retry, ambiguous });
  }
  if (response.status === 204) return null;
  if (result === null || typeof result !== "object") {
    throw new ApiError("Discord returned an unreadable response.", { status: response.status, ambiguous });
  }
  return result;
}

function deliveredImage(response, photo) {
  const encoding = (response.headers.get("content-encoding") ?? "identity").trim().toLowerCase() || "identity";
  // Workers decodes gzip/Brotli when the body is read. Other encodings are
  // rejected before POST so compressed bytes cannot be mislabeled as an image.
  if (!["identity", "gzip", "br"].includes(encoding)) {
    throw new ApiError("Discord returned an unsupported image encoding. Upload the image again with /post.");
  }
  const declared = response.headers.get("content-length");
  let declaredSize = null;
  if (declared !== null) {
    if (!/^[0-9]+$/.test(declared)) {
      throw new ApiError("Discord returned an invalid image download length. Upload it again with /post.");
    }
    declaredSize = Number(declared);
    if (!Number.isSafeInteger(declaredSize) || declaredSize <= 0) {
      throw new ApiError("Discord returned an invalid or empty image download. Upload it again with /post.");
    }
    if (declaredSize > MAX_PHOTO_BYTES) {
      throw new ApiError("The downloaded image exceeds 25 MiB. Use a smaller photo.");
    }
  }
  const responseMime = (response.headers.get("content-type") ?? "").split(";", 1)[0].trim().toLowerCase();
  const genericMime = ["", "application/octet-stream", "binary/octet-stream"].includes(responseMime);
  const mime = genericMime ? photo.content_type : responseMime;
  if (!IMAGE_TYPES.has(mime)) {
    throw new ApiError("Discord returned an unsupported image format. Upload a JPG, PNG, GIF, or WebP image.");
  }
  return {
    // Attachment.size describes the original upload. A CDN representation may
    // differ. Encoded Content-Length also cannot frame the decoded body stream.
    expectedSize: encoding === "identity" ? declaredSize : null,
    contentType: mime,
    filename: cleanFilename(photo.filename, mime, photo.id),
  };
}

function streamedMultipart(header, imageBody, footer, expectedSize) {
  const reader = imageBody.getReader();
  let phase = 0;
  let transferred = 0;
  const source = new ReadableStream({
    async pull(controller) {
      try {
        if (phase === 0) {
          phase = 1;
          controller.enqueue(header);
          return;
        }
        if (phase === 1) {
          const { done, value } = await reader.read();
          if (!done) {
            transferred += value.byteLength;
            if (transferred > MAX_PHOTO_BYTES) {
              await reader.cancel();
              throw new ApiError("The downloaded image exceeds 25 MiB. Use a smaller photo.");
            }
            if (expectedSize !== null && transferred > expectedSize) {
              await reader.cancel();
              throw new ApiError("The image size changed during download. Upload it again with /post.");
            }
            controller.enqueue(value);
            return;
          }
          if (transferred === 0) throw new ApiError("Discord returned an empty image download. Upload it again with /post.");
          if (expectedSize !== null && transferred !== expectedSize) throw new ApiError("The image download was incomplete. Upload it again with /post.");
          phase = 2;
          controller.enqueue(footer);
          controller.close();
        }
      } catch (error) {
        controller.error(error);
      }
    },
    async cancel() { await reader.cancel().catch(() => {}); },
  });
  const length = expectedSize === null ? null : header.byteLength + expectedSize + footer.byteLength;
  let body = source;
  let pump = null;
  // FixedLengthStream makes Workers send the correct Content-Length for a streamed body.
  if (length !== null && typeof globalThis.FixedLengthStream === "function") {
    const fixed = new globalThis.FixedLengthStream(length);
    pump = source.pipeTo(fixed.writable);
    pump.catch(() => {}); // The caller awaits the same promise after fetch succeeds.
    body = fixed.readable;
  }
  return {
    body, length, pump,
    async cancel() {
      await reader.cancel().catch(() => {});
      try { reader.releaseLock(); } catch {}
    },
  };
}

export class DiscordApi {
  constructor(env, fetchImpl = globalThis.fetch) {
    this.token = env.DISCORD_TOKEN;
    // Workerd's native fetch requires its global receiver, unlike most Node mocks.
    this.fetch = fetchImpl.bind(globalThis);
  }

  async request(method, path, body) {
    if (typeof this.token !== "string" || !this.token) throw new ApiError("The Discord bot token has not been configured.");
    if (typeof path !== "string" || !path.startsWith("/") || path.startsWith("//")) throw new ApiError("Invalid Discord API route.");
    let response;
    try {
      response = await this.fetch(API_BASE + path, {
        method,
        headers: { Authorization: "Bot " + this.token, ...(body === undefined ? {} : { "Content-Type": "application/json" }) },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        signal: AbortSignal.timeout(30_000),
        redirect: "manual",
      });
    } catch {
      throw new ApiError("Could not connect to Discord. Try again later.", { ambiguous: !["GET", "HEAD"].includes(method) });
    }
    return parseResponse(response);
  }

  getGuild(guildId) { return this.request("GET", "/guilds/" + id(guildId)); }
  getRoles(guildId) { return this.request("GET", "/guilds/" + id(guildId) + "/roles"); }
  getMember(guildId, userId) { return this.request("GET", "/guilds/" + id(guildId) + "/members/" + id(userId)); }
  getChannel(channelId) { return this.request("GET", "/channels/" + id(channelId)); }

  async editReply(applicationId, interactionToken, content) {
    if (typeof interactionToken !== "string" || !interactionToken) throw new ApiError("The private response token is unavailable.");
    let response;
    try {
      response = await this.fetch(API_BASE + "/webhooks/" + id(applicationId) + "/" + encodeURIComponent(interactionToken) + "/messages/@original", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ content, allowed_mentions: { parse: [], users: [], roles: [], replied_user: false } }),
        signal: AbortSignal.timeout(30_000),
        redirect: "manual",
      });
    } catch {
      throw new ApiError("Could not update the private Discord response.");
    }
    return parseResponse(response);
  }

  async sendPhoto(channelId, { content, allowed_mentions, nonce, attachment }) {
    const destination = id(channelId);
    const dedupeNonce = id(nonce);
    if (typeof this.token !== "string" || !this.token) throw new ApiError("The Discord bot token has not been configured.");
    if (typeof content !== "string" || content.length > 2000) throw new ApiError("The pings and caption must fit within 2000 characters.");
    const photo = validateAttachment(attachment);
    const allowed = mentions(allowed_mentions);
    let image;
    try {
      image = await this.fetch(photo.url, {
        headers: { "Accept-Encoding": "identity", Accept: photo.content_type },
        redirect: "manual", signal: AbortSignal.timeout(90_000),
      });
    } catch {
      throw new ApiError("Could not download the photo. Upload it again with /post.");
    }
    if (image.status !== 200 || !image.body || image.headers.has("content-range")) {
      await image.body?.cancel().catch(() => {});
      throw new ApiError("Discord could not supply this photo. Upload it again directly in the /post attachment field.", { status: image.status });
    }
    let delivery;
    try {
      delivery = deliveredImage(image, photo);
    } catch (error) {
      await image.body.cancel().catch(() => {});
      throw error;
    }
    const boundary = "discord-photo-" + crypto.randomUUID().replaceAll("-", "");
    const payload = JSON.stringify({
      content,
      allowed_mentions: allowed,
      nonce: dedupeNonce,
      enforce_nonce: true,
      attachments: [{ id: 0, filename: delivery.filename }],
    });
    const header = encoder.encode(
      "--" + boundary + "\r\nContent-Disposition: form-data; name=\"payload_json\"\r\nContent-Type: application/json\r\n\r\n" +
      payload + "\r\n--" + boundary + "\r\nContent-Disposition: form-data; name=\"files[0]\"; filename=\"" + delivery.filename +
      "\"\r\nContent-Type: " + delivery.contentType + "\r\n\r\n"
    );
    const footer = encoder.encode("\r\n--" + boundary + "--\r\n");
    const upload = streamedMultipart(header, image.body, footer, delivery.expectedSize);
    let definiteRejection = false;
    try {
      const response = await this.fetch(API_BASE + "/channels/" + destination + "/messages", {
        method: "POST",
        headers: {
          Authorization: "Bot " + this.token,
          "Content-Type": "multipart/form-data; boundary=" + boundary,
          ...(upload.length === null ? {} : { "Content-Length": String(upload.length) }),
        },
        body: upload.body,
        duplex: "half",
        redirect: "manual",
        signal: AbortSignal.timeout(90_000),
      });
      if (!response.ok) {
        // Discord's explicit client-error response rejects the message. A timeout
        // or server failure can leave its result uncertain, so never infer failure.
        definiteRejection = response.status >= 400 && response.status < 500 && response.status !== 408;
        await upload.cancel();
        return await parseResponse(response, !definiteRejection);
      }
      if (upload.pump) await upload.pump;
      const result = await parseResponse(response, true);
      if (!result?.id || !/^[1-9][0-9]{0,19}$/.test(String(result.id))) {
        throw new ApiError("Discord may have posted the image, but did not return its message ID.", { ambiguous: true });
      }
      return result;
    } catch (error) {
      if (error instanceof ApiError) {
        if (!definiteRejection) error.ambiguous = true;
        throw error;
      }
      throw new ApiError("The upload result is uncertain. Check the post channel before retrying.", { ambiguous: true });
    } finally {
      await upload.cancel();
    }
  }
}
