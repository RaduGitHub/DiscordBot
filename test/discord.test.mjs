import test from "node:test";
import assert from "node:assert/strict";
import { TransformStream as NodeTransformStream } from "node:stream/web";
import {
  ApiError, DiscordApi, MAX_PHOTO_BYTES, PERMISSIONS as P,
  effectivePermissions, isTextChannel, validateAttachment,
} from "../src/discord.mjs";

const token = "not-a-real-bot-token";
const application = "100000000000000001";
const guild = { id: "100000000000000002", owner_id: "100000000000000003" };
const user = { user: { id: "100000000000000004" }, roles: ["100000000000000005"] };
const baseRole = { id: guild.id, permissions: String(P.VIEW_CHANNEL | P.SEND_MESSAGES) };
const extraRole = { id: user.roles[0], permissions: String(P.ATTACH_FILES) };
const channel = { id: "100000000000000006", guild_id: guild.id, type: 0, permission_overwrites: [] };
const attachment = {
  id: "100000000000000007", filename: "photo.png", content_type: "image/png", size: 8,
  url: "https://cdn.discordapp.com/ephemeral-attachments/100000000000000001/100000000000000007/photo.png?ex=abc&hm=signed-private",
};
const options = () => ({
  content: "<@100000000000000004> @everyone <@999>",
  allowed_mentions: { parse: ["everyone"], users: [user.user.id, user.user.id], roles: [] },
  nonce: "100000000000000008", attachment: { ...attachment },
});
const json = (value, status = 200, headers = {}) => new Response(JSON.stringify(value), {
  status, headers: { "Content-Type": "application/json", ...headers },
});
const image = (bytes = "12345678", headers = {}) => new Response(bytes, { headers: {
  "Content-Type": "image/png",
  "Content-Length": String(typeof bytes === "string" ? new TextEncoder().encode(bytes).byteLength : bytes.byteLength),
  ...headers,
} });

test("permissions combine everyone and assigned roles", () => {
  const permissions = effectivePermissions(guild, [baseRole, extraRole], user, channel);
  assert.equal(permissions, P.VIEW_CHANNEL | P.SEND_MESSAGES | P.ATTACH_FILES);
});
test("guild owner bypasses overwrites", () => {
  const member = { user: { id: guild.owner_id }, roles: [] };
  assert.ok(effectivePermissions(guild, [], member, { permission_overwrites: [{ id: guild.id, type: 0, deny: String(P.VIEW_CHANNEL), allow: "0" }] }) & P.ATTACH_FILES);
});
test("Administrator bypasses channel denies", () => {
  const roles = [baseRole, { ...extraRole, permissions: String(P.ADMINISTRATOR) }];
  assert.ok(effectivePermissions(guild, roles, user, { permission_overwrites: [{ id: user.user.id, type: 1, deny: String(P.VIEW_CHANNEL), allow: "0" }] }) & P.VIEW_CHANNEL);
});
test("everyone overwrite deny is applied", () => {
  const target = { ...channel, permission_overwrites: [{ type: 0, id: guild.id, deny: String(P.SEND_MESSAGES), allow: "0" }] };
  assert.equal(effectivePermissions(guild, [baseRole], user, target), P.VIEW_CHANNEL);
});
test("role allows are aggregated after role denies", () => {
  const member = { ...user, roles: [extraRole.id, "100000000000000009"] };
  const target = { ...channel, permission_overwrites: [
    { type: 0, id: extraRole.id, deny: String(P.SEND_MESSAGES), allow: "0" },
    { type: 0, id: member.roles[1], deny: "0", allow: String(P.SEND_MESSAGES) },
  ] };
  assert.ok(effectivePermissions(guild, [baseRole], member, target) & P.SEND_MESSAGES);
});
test("member overwrite is final", () => {
  const target = { ...channel, permission_overwrites: [
    { type: 0, id: extraRole.id, deny: "0", allow: String(P.ATTACH_FILES) },
    { type: 1, id: user.user.id, deny: String(P.ATTACH_FILES), allow: "0" },
  ] };
  assert.equal(effectivePermissions(guild, [baseRole, extraRole], user, target) & P.ATTACH_FILES, 0n);
});
test("permissions retain bits above the 32-bit range", () => {
  const high = 1n << 45n;
  assert.ok(effectivePermissions(guild, [{ ...baseRole, permissions: String(high) }], user, channel) & high);
});
test("malformed permission values do not grant access", () => {
  assert.equal(effectivePermissions(guild, [{ ...baseRole, permissions: "broken" }], user, channel), 0n);
});
test("channel validation permits only same-guild text and announcements", () => {
  assert.equal(isTextChannel(channel, guild.id), true);
  assert.equal(isTextChannel({ ...channel, type: 5 }, guild.id), true);
  assert.equal(isTextChannel({ ...channel, type: 11 }, guild.id), false);
  assert.equal(isTextChannel(channel, "999"), false);
});

test("ephemeral signed CDN attachment is accepted", () => {
  assert.equal(validateAttachment(attachment).url, attachment.url);
});
test("normal signed CDN attachment is accepted", () => {
  assert.equal(validateAttachment({ ...attachment, url: attachment.url.replace("ephemeral-attachments", "attachments") }).id, attachment.id);
});
test("external HTTP and credential-bearing attachment URLs are refused", () => {
  for (const url of [
    "http://cdn.discordapp.com/attachments/1/100000000000000007/photo.png",
    "https://example.com/attachments/1/100000000000000007/photo.png",
    "https://cdn.discordapp.com.evil.example/attachments/1/100000000000000007/photo.png",
    "https://user:secret@cdn.discordapp.com/attachments/1/100000000000000007/photo.png",
    "https://cdn.discordapp.com:444/attachments/1/100000000000000007/photo.png",
    "https://cdn.discordapp.com/attachments/1/999/photo.png",
  ]) {
    assert.throws(() => validateAttachment({ ...attachment, url }), ApiError);
  }
});
test("unsupported media and invalid sizes are refused", () => {
  for (const patch of [
    { content_type: "video/mp4" }, { content_type: "" }, { size: 0 },
    { size: -1 }, { size: MAX_PHOTO_BYTES + 1 }, { size: 2.5 },
  ]) assert.throws(() => validateAttachment({ ...attachment, ...patch }), ApiError);
});
test("spoiler preserved and filename header injection removed", () => {
  const photo = validateAttachment({ ...attachment, filename: 'SPOILER_photo"\r\nX-Injected: yes;/image.png' });
  assert.ok(photo.filename.startsWith("SPOILER_"));
  assert.equal(/[\r\n";/\\]/.test(photo.filename), false);
  assert.ok(photo.filename.endsWith(".png"));
});
test("missing image extension gets canonical image suffix", () => {
  assert.ok(validateAttachment({ ...attachment, filename: "photo.exe" }).filename.endsWith(".png"));
});
test("errors do not expose private signed attachment URL", () => {
  let error;
  try { validateAttachment({ ...attachment, url: "https://example.com/?secret=private" }); } catch (caught) { error = caught; }
  assert.equal(JSON.stringify(error).includes("secret=private"), false);
  assert.equal(String(error).includes("example.com"), false);
});

test("REST request carries Bot auth and routes through API v10", async () => {
  const calls = [];
  const api = new DiscordApi({ DISCORD_TOKEN: token }, async (url, init) => { calls.push({ url, init }); return json(guild); });
  assert.equal((await api.getGuild(guild.id)).id, guild.id);
  assert.equal(calls[0].url, "https://discord.com/api/v10/guilds/" + guild.id);
  assert.equal(calls[0].init.headers.Authorization, "Bot " + token);
  assert.equal(calls[0].init.redirect, "manual");
});
test("fetch is called with the global receiver required by workerd", async () => {
  let calls = 0;
  const api = new DiscordApi({ DISCORD_TOKEN: token }, async function () {
    assert.equal(this, globalThis);
    calls++;
    return json(guild);
  });
  assert.equal((await api.getGuild(guild.id)).id, guild.id);
  assert.equal(calls, 1);
});
test("REST permission errors retain safe numeric details only", async () => {
  const api = new DiscordApi({ DISCORD_TOKEN: token }, async () => json({ code: 50013, message: "secret-" + token }, 403));
  await assert.rejects(api.getChannel(channel.id), (error) => error instanceof ApiError && error.status === 403 && error.code === 50013 && !String(error).includes(token));
});
test("REST rate limits expose retry delay", async () => {
  const api = new DiscordApi({ DISCORD_TOKEN: token }, async () => json({ retry_after: 1.5 }, 429));
  await assert.rejects(api.getChannel(channel.id), (error) => error.retryAfter === 1.5);
});
test("REST redirects are rejected without following or exposing credentials", async () => {
  let calls = 0;
  const api = new DiscordApi({ DISCORD_TOKEN: token }, async (url, init) => {
    calls++;
    assert.ok(url.startsWith("https://discord.com/api/v10/"));
    assert.equal(init.redirect, "manual");
    return new Response(null, { status: 302, headers: { Location: "https://attacker.example/" + token } });
  });
  await assert.rejects(api.getChannel(channel.id), error => error.status === 302 && !error.ambiguous && !String(error).includes(token));
  assert.equal(calls, 1);
});
test("REST network failure is sanitized and not retried", async () => {
  let count = 0;
  const api = new DiscordApi({ DISCORD_TOKEN: token }, async () => { count++; throw new Error("URL token=" + token); });
  await assert.rejects(api.getChannel(channel.id), (error) => !String(error).includes(token) && !error.ambiguous);
  assert.equal(count, 1);
});
test("REST invalid routes and missing token never fetch", async () => {
  const api = new DiscordApi({}, async () => assert.fail("No fetch expected"));
  await assert.rejects(api.getChannel(channel.id), ApiError);
  const configured = new DiscordApi({ DISCORD_TOKEN: token }, async () => assert.fail("No fetch expected"));
  await assert.rejects(configured.request("GET", "//attacker.example"), ApiError);
});
test("private receipt uses interaction token only and suppresses all mentions", async () => {
  const api = new DiscordApi({ DISCORD_TOKEN: token }, async (url, init) => {
    assert.ok(url.includes("/webhooks/" + application + "/private-reply-token/messages/@original"));
    assert.equal(init.headers.Authorization, undefined);
    assert.equal(init.redirect, "manual");
    assert.deepEqual(JSON.parse(init.body).allowed_mentions.parse, []);
    return json({ id: "123" });
  });
  await api.editReply(application, "private-reply-token", "Done @everyone");
});
test("private receipt redirects are rejected without following the token-bearing URL", async () => {
  let calls = 0;
  const api = new DiscordApi({ DISCORD_TOKEN: token }, async (_url, init) => {
    calls++;
    assert.equal(init.redirect, "manual");
    return new Response(null, { status: 307, headers: { Location: "https://attacker.example/private-reply-token" } });
  });
  await assert.rejects(api.editReply(application, "private-reply-token", "Done"), error => error.status === 307 && !String(error).includes("private-reply-token"));
  assert.equal(calls, 1);
});

test("photo transfer streams multipart with byte-exact length and enforced nonce", async () => {
  let calls = 0;
  const api = new DiscordApi({ DISCORD_TOKEN: token }, async (url, init) => {
    calls++;
    if (calls === 1) {
      assert.equal(url, attachment.url);
      assert.equal(init.redirect, "manual");
      assert.deepEqual(init.headers, { "Accept-Encoding": "identity", Accept: "image/png" });
      assert.equal(Object.hasOwn(init.headers, "Authorization"), false);
      return image();
    }
    assert.equal(url, "https://discord.com/api/v10/channels/" + channel.id + "/messages");
    assert.equal(init.method, "POST");
    assert.equal(init.redirect, "manual");
    assert.equal(init.duplex, "half");
    assert.ok(init.body instanceof ReadableStream);
    const bytes = await new Response(init.body).arrayBuffer();
    assert.equal(Number(init.headers["Content-Length"]), bytes.byteLength);
    const text = new TextDecoder().decode(bytes);
    const payload = JSON.parse(text.split("\r\n\r\n")[1].split("\r\n--")[0]);
    assert.equal(payload.enforce_nonce, true);
    assert.equal(payload.nonce, options().nonce);
    assert.deepEqual(payload.allowed_mentions, { parse: [], users: [user.user.id], roles: [], replied_user: false });
    assert.ok(text.includes('name="files[0]"; filename="photo.png"'));
    assert.ok(text.includes("\r\n\r\n12345678\r\n"));
    return json({ id: "100000000000000010" });
  });
  assert.equal((await api.sendPhoto(channel.id, options())).id, "100000000000000010");
  assert.equal(calls, 2);
});
test("CDN access failure happens before public message creation", async () => {
  let calls = 0;
  const api = new DiscordApi({ DISCORD_TOKEN: token }, async () => { calls++; return new Response("forbidden", { status: 403 }); });
  await assert.rejects(api.sendPhoto(channel.id, options()), (error) => !error.ambiguous && error.userMessage.includes("/post"));
  assert.equal(calls, 1);
});
test("CDN redirects are not followed", async () => {
  let calls = 0;
  const api = new DiscordApi({ DISCORD_TOKEN: token }, async () => { calls++; return new Response(null, { status: 302, headers: { Location: "https://example.com" } }); });
  await assert.rejects(api.sendPhoto(channel.id, options()), (error) => !error.ambiguous);
  assert.equal(calls, 1);
});
test("delivered image size can differ from original attachment metadata", async () => {
  for (const bytes of ["123", "123456789"]) {
    let calls = 0;
    const api = new DiscordApi({ DISCORD_TOKEN: token }, async (url, init) => {
      if (++calls === 1) return image(bytes);
      const body = await new Response(init.body).text();
      assert.equal(Number(init.headers["Content-Length"]), new TextEncoder().encode(body).byteLength);
      assert.ok(body.includes("\r\n\r\n" + bytes + "\r\n"));
      return json({ id: "123" });
    });
    assert.equal((await api.sendPhoto(channel.id, options())).id, "123");
    assert.equal(calls, 2);
  }
});
test("actual image-size mismatch aborts the streamed upload", async () => {
  for (const bytes of ["123", "123456789"]) {
    let calls = 0;
    const api = new DiscordApi({ DISCORD_TOKEN: token }, async (_url, init) => {
      calls++;
      if (calls === 1) return image(bytes, { "Content-Length": "8" });
      await new Response(init.body).arrayBuffer();
      assert.fail("Mismatched stream cannot finish");
    });
    await assert.rejects(api.sendPhoto(channel.id, options()), (error) => error.ambiguous);
    assert.equal(calls, 2);
  }
});

test("invalid or over-limit delivered lengths fail before public POST", async () => {
  for (const length of ["-1", "0", "", "8x", "1.5", "1e2", "8, 8", "NaN", "Infinity", String(MAX_PHOTO_BYTES + 1), "9007199254740993"]) {
    let calls = 0;
    const api = new DiscordApi({ DISCORD_TOKEN: token }, async () => {
      calls++;
      return image("12345678", { "Content-Length": length });
    });
    await assert.rejects(api.sendPhoto(channel.id, options()), error => error instanceof ApiError && !error.ambiguous);
    assert.equal(calls, 1);
  }
});

test("partial CDN responses and Content-Range fail before public POST", async () => {
  for (const response of [
    new Response("12345678", { status: 206, headers: { "Content-Length": "8", "Content-Type": "image/png" } }),
    image("12345678", { "Content-Range": "bytes 0-7/16" }),
  ]) {
    let calls = 0;
    const api = new DiscordApi({ DISCORD_TOKEN: token }, async () => { calls++; return response; });
    await assert.rejects(api.sendPhoto(channel.id, options()), error => !error.ambiguous);
    assert.equal(calls, 1);
  }
});

test("unknown delivered length uses bounded chunked multipart rather than a guessed fixed size", async () => {
  const previous = globalThis.FixedLengthStream;
  globalThis.FixedLengthStream = class { constructor() { assert.fail("Unknown length must not use FixedLengthStream"); } };
  try {
    let calls = 0;
    const api = new DiscordApi({ DISCORD_TOKEN: token }, async (_url, init) => {
      if (++calls === 1) return new Response(new TextEncoder().encode("different-size"), { headers: { "Content-Type": "image/png" } });
      assert.equal(Object.hasOwn(init.headers, "Content-Length"), false);
      assert.ok((await new Response(init.body).text()).includes("\r\n\r\ndifferent-size\r\n"));
      return json({ id: "123" });
    });
    assert.equal((await api.sendPhoto(channel.id, options())).id, "123");
    assert.equal(calls, 2);
  } finally {
    if (previous === undefined) delete globalThis.FixedLengthStream;
    else globalThis.FixedLengthStream = previous;
  }
});

test("unknown-length image streams cannot exceed the actual byte cap", async () => {
  let calls = 0;
  const api = new DiscordApi({ DISCORD_TOKEN: token }, async (_url, init) => {
    if (++calls === 1) return new Response(new ReadableStream({
      start(controller) { controller.enqueue(new Uint8Array(MAX_PHOTO_BYTES + 1)); controller.close(); },
    }), { headers: { "Content-Type": "image/png" } });
    await new Response(init.body).arrayBuffer();
    assert.fail("Over-limit stream must not complete");
  });
  await assert.rejects(api.sendPhoto(channel.id, options()), error => error.ambiguous && error.userMessage.includes("25 MiB"));
  assert.equal(calls, 2);
});

test("unknown-length empty image stream cannot finish an upload", async () => {
  let calls = 0;
  const api = new DiscordApi({ DISCORD_TOKEN: token }, async (_url, init) => {
    if (++calls === 1) return new Response(new Uint8Array(), { headers: { "Content-Type": "image/png" } });
    await new Response(init.body).arrayBuffer();
    assert.fail("Empty stream must not complete");
  });
  await assert.rejects(api.sendPhoto(channel.id, options()), error => error.ambiguous && error.userMessage.includes("empty"));
  assert.equal(calls, 2);
});

test("compressed response length is not used to frame the decoded image body", async () => {
  for (const encoding of ["gzip", "br"]) {
    let calls = 0;
    const api = new DiscordApi({ DISCORD_TOKEN: token }, async (_url, init) => {
      // The mock models Workers fetch's decoded body, whose original encoded
      // Content-Length can differ. Root's native runtime test checks decoding.
      if (++calls === 1) return image("12345678", { "Content-Encoding": encoding, "Content-Length": "3" });
      assert.equal(Object.hasOwn(init.headers, "Content-Length"), false);
      assert.ok((await new Response(init.body).text()).includes("\r\n\r\n12345678\r\n"));
      return json({ id: "123" });
    });
    assert.equal((await api.sendPhoto(channel.id, options())).id, "123");
    assert.equal(calls, 2);
  }
});

test("unsupported response encoding fails before public POST", async () => {
  let calls = 0;
  const api = new DiscordApi({ DISCORD_TOKEN: token }, async () => {
    calls++;
    return image("12345678", { "Content-Encoding": "zstd" });
  });
  await assert.rejects(api.sendPhoto(channel.id, options()), error => !error.ambiguous && error.userMessage.includes("encoding"));
  assert.equal(calls, 1);
});

test("deflate response is rejected before public POST because Workers does not decode it", async () => {
  let calls = 0;
  const api = new DiscordApi({ DISCORD_TOKEN: token }, async () => {
    calls++;
    return image("12345678", { "Content-Length": "8", "Content-Encoding": "deflate" });
  });
  await assert.rejects(api.sendPhoto(channel.id, options()), error =>
    error instanceof ApiError && !error.ambiguous && /unsupported image encoding/.test(error.userMessage));
  assert.equal(calls, 1);
});

test("actual response image MIME and suffix stay aligned and spoilers are preserved", async () => {
  let calls = 0;
  const original = { ...options(), attachment: { ...attachment, filename: "SPOILER_photo.png" } };
  const api = new DiscordApi({ DISCORD_TOKEN: token }, async (_url, init) => {
    if (++calls === 1) return image("1234", { "Content-Type": "image/webp" });
    const body = await new Response(init.body).text();
    assert.ok(body.includes('filename="SPOILER_photo.webp"'));
    assert.ok(body.includes('"filename":"SPOILER_photo.webp"'));
    assert.ok(body.includes("\r\nContent-Type: image/webp\r\n"));
    assert.equal(body.includes("image/png"), false);
    return json({ id: "123" });
  });
  await api.sendPhoto(channel.id, original);
  assert.equal(calls, 2);
});

test("generic and missing response MIME use the validated attachment MIME", async () => {
  for (const mime of [null, "", "application/octet-stream", "binary/octet-stream"]) {
    let calls = 0;
    const api = new DiscordApi({ DISCORD_TOKEN: token }, async (_url, init) => {
      if (++calls === 1) {
        const response = image();
        if (mime === null) response.headers.delete("Content-Type");
        else response.headers.set("Content-Type", mime);
        return response;
      }
      const body = await new Response(init.body).text();
      assert.ok(body.includes("\r\nContent-Type: image/png\r\n"));
      return json({ id: "123" });
    });
    await api.sendPhoto(channel.id, options());
  }
});

test("unsupported explicit response MIME fails before public POST", async () => {
  for (const mime of ["text/html", "application/json", "image/heic", "image/avif"]) {
    let calls = 0;
    const api = new DiscordApi({ DISCORD_TOKEN: token }, async () => { calls++; return image("12345678", { "Content-Type": mime }); });
    await assert.rejects(api.sendPhoto(channel.id, options()), error => !error.ambiguous && error.userMessage.includes("format"));
    assert.equal(calls, 1);
  }
});

test("CDN identity request preserves the full signed URL and never carries Bot auth", async () => {
  const original = { ...options(), attachment: { ...attachment,
    url: attachment.url.replace("cdn.discordapp.com", "media.discordapp.net") + "&width=1024&format=webp",
  } };
  let calls = 0;
  const api = new DiscordApi({ DISCORD_TOKEN: token }, async (url, init) => {
    if (++calls === 1) {
      assert.equal(url, original.attachment.url);
      assert.deepEqual(init.headers, { "Accept-Encoding": "identity", Accept: "image/png" });
      return image();
    }
    await new Response(init.body).arrayBuffer();
    return json({ id: "123" });
  });
  await api.sendPhoto(channel.id, original);
});
test("public POST network failure is uncertain and never retried", async () => {
  let calls = 0;
  const api = new DiscordApi({ DISCORD_TOKEN: token }, async (_url, init) => {
    calls++;
    if (calls === 1) return image();
    await new Response(init.body).arrayBuffer();
    throw new Error("secret token: " + token);
  });
  await assert.rejects(api.sendPhoto(channel.id, options()), (error) => error.ambiguous && !String(error).includes(token));
  assert.equal(calls, 2);
});
test("public POST permission rejection is definite, helpful and not retried", async () => {
  let calls = 0;
  const api = new DiscordApi({ DISCORD_TOKEN: token }, async (_url, init) => {
    calls++;
    if (calls === 1) return image();
    await new Response(init.body).arrayBuffer();
    return json({ code: 50013, message: token }, 403);
  });
  await assert.rejects(api.sendPhoto(channel.id, options()), (error) => !error.ambiguous && error.status === 403 && error.userMessage.includes("permissions") && !String(error).includes(token));
  assert.equal(calls, 2);
});
test("public POST file-size rejection is definite and helpful", async () => {
  let calls = 0;
  const api = new DiscordApi({ DISCORD_TOKEN: token }, async (_url, init) => {
    calls++;
    if (calls === 1) return image();
    await new Response(init.body).arrayBuffer();
    return json({ code: 40005, message: token }, 400);
  });
  await assert.rejects(api.sendPhoto(channel.id, options()), (error) => !error.ambiguous && error.status === 400 && error.code === 40005 && error.userMessage.includes("smaller photo") && !String(error).includes(token));
  assert.equal(calls, 2);
});
test("public POST rate-limit rejection is definite without automatic retries", async () => {
  let calls = 0;
  const api = new DiscordApi({ DISCORD_TOKEN: token }, async (_url, init) => {
    calls++;
    if (calls === 1) return image();
    await new Response(init.body).arrayBuffer();
    return json({ retry_after: 2 }, 429);
  });
  await assert.rejects(api.sendPhoto(channel.id, options()), (error) => !error.ambiguous && error.retryAfter === 2);
  assert.equal(calls, 2);
});
test("public POST server and timeout failures remain uncertain", async () => {
  for (const status of [408, 500, 502, 503]) {
    let calls = 0;
    const api = new DiscordApi({ DISCORD_TOKEN: token }, async (_url, init) => {
      calls++;
      if (calls === 1) return image();
      await new Response(init.body).arrayBuffer();
      return json({ message: token }, status);
    });
    await assert.rejects(api.sendPhoto(channel.id, options()), (error) => error.ambiguous && !String(error).includes(token));
    assert.equal(calls, 2);
  }
});
test("public POST redirect is uncertain and never follows or forwards Bot auth", async () => {
  let calls = 0;
  const api = new DiscordApi({ DISCORD_TOKEN: token }, async (url, init) => {
    calls++;
    assert.equal(init.redirect, "manual");
    if (calls === 1) return image();
    assert.ok(url.startsWith("https://discord.com/api/v10/channels/"));
    await new Response(init.body).arrayBuffer();
    return new Response(null, { status: 302, headers: { Location: "https://attacker.example/" + token } });
  });
  await assert.rejects(api.sendPhoto(channel.id, options()), error => error.status === 302 && error.ambiguous && !String(error).includes(token));
  assert.equal(calls, 2);
});
test("unreadable successful POST response and missing message ID remain uncertain", async () => {
  for (const responseFactory of [() => new Response("bad-json"), () => json({})]) {
    let calls = 0;
    const api = new DiscordApi({ DISCORD_TOKEN: token }, async (_url, init) => {
      calls++;
      if (calls === 1) return image();
      await new Response(init.body).arrayBuffer();
      return responseFactory();
    });
    await assert.rejects(api.sendPhoto(channel.id, options()), (error) => error.ambiguous);
  }
});
test("invalid content and attachment are rejected before all network calls", async () => {
  const api = new DiscordApi({ DISCORD_TOKEN: token }, async () => assert.fail("No network expected"));
  await assert.rejects(api.sendPhoto(channel.id, { ...options(), content: "x".repeat(2001) }), ApiError);
  await assert.rejects(api.sendPhoto(channel.id, { ...options(), attachment: { ...attachment, size: MAX_PHOTO_BYTES + 1 } }), ApiError);
});

test("FixedLengthStream branch preserves streamed multipart", async () => {
  const previous = globalThis.FixedLengthStream;
  let expectedLength = 0;
  globalThis.FixedLengthStream = class {
    constructor(length) {
      expectedLength = length;
      let count = 0;
      const stream = new NodeTransformStream({
        transform(chunk, controller) { count += chunk.byteLength; controller.enqueue(chunk); },
        flush() { assert.equal(count, length); },
      });
      this.readable = stream.readable;
      this.writable = stream.writable;
    }
  };
  try {
    let calls = 0;
    const api = new DiscordApi({ DISCORD_TOKEN: token }, async (_url, init) => {
      if (++calls === 1) return image();
      const body = await new Response(init.body).arrayBuffer();
      assert.equal(body.byteLength, expectedLength);
      return json({ id: "123" });
    });
    await api.sendPhoto(channel.id, options());
  } finally {
    if (previous === undefined) delete globalThis.FixedLengthStream;
    else globalThis.FixedLengthStream = previous;
  }
});
