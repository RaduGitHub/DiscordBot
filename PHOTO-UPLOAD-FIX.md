# Photo download size fix

The error "The image size does not match its attachment" came from comparing
Discord's attachment metadata with the CDN download's Content-Length. A different
download representation or HTTP compression can make those values differ. This
error alone does not mean the phone photo exceeds the upload limit.

The bot now requests the original image type and identity encoding. It uses the
delivered length when available and streams unknown or decoded lengths without
guessing their size. It still rejects oversized downloads, partial HTTP responses,
empty downloads, unsupported media, and incorrect known-length transfers.

## Apply to your deployed bot

This repository includes the updated `src/discord.mjs`. After configuring your
checkout as described in the README, open a terminal at its root and run:

```cmd
npm run deploy
```

Then retry a fresh `/post` attachment from your phone. Command registration,
database schema, secrets, saved channels, and saved pings do not need changes.

If updating a separate existing bot folder, replace its `src/discord.mjs` while
keeping its own `wrangler.jsonc` and `.dev.vars`, then deploy.

The code limit remains 25 MiB, and Discord's own upload allowance also applies.
A separate "25 MiB" or "Discord rejected the image size" error indicates an actual
size limit rather than the metadata comparison fixed here.

Validation: 168 automated tests, Wrangler build, and native workerd flows for
ordinary, mismatched-length, unknown-length, gzip, and Brotli downloads, plus safe
rejection of unsupported deflate encoding before a public upload.
Discord API calls in those tests were local mocks; a fresh phone upload after
deployment is the remaining live check.
