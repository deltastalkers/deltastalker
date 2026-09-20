# [deltastalker](https://deltastalkers.github.io/)
**a script for automatically checking activity related to Toby Fox and UNDERTALE/DELTARUNE**

license: [GNU Affero General Public License v3.0](LICENSE)

## setup
1. clone the repository (`git clone https://github.com/deltastalkers/deltastalker.git`)
2. install packages with `npm install`
3. [make `config.json` and `.env` files](#schemas)

to run, use `npm start`

## schemas
### `config.json`
```json
{
  "roles": { // discord role ID, emoji for button, description for message
    "newsletters": [ "Snowflake", "✉️", "string" ],
    "pages": [ "Snowflake", "🌐", "string" ],
    "twitter": [ "Snowflake", "🐦", "string" ],
    "bluesky": [ "Snowflake", "🦋", "string" ],
    ...
  },
  "pages": [
    {
      "url": "string",
      "name": "string",
      "settings": { ... } // refers to `screenshot` function's parameters in `utils/screenshot.js`
    },
    ...
  ],
  "channels": { // discord channel IDs
    "newsletters": "Snowflake",
    "pages": "Snowflake",
    "twitter": "Snowflake",
    "bluesky": "Snowflake",
    "logs": "Snowflake",
    "info": "Snowflake"
  },
  "server": {
    "maxAttempts": number, // max login attempts allowed before blocking 
    "window": number // time window in seconds for logins
  },
  "maxLogs": number, // OPTIONAL, max logs to keep in memory, defaults to 100
  "maxAge": number, // max post age in seconds
  "interval": number // interval between checks in seconds
}
```
---
### `.env`
```ini
TWITTER_AUTH="" # twitter account auth cookie
DISCORD_TOKEN="" # discord bot token
BSKY_HANDLE="" # bluesky account username
BSKY_PASSWORD="" # bluesky account password
USERNAME="" # debug server username
PASSWORD="" # debug server password
PORT=1111 # OPTIONAL, debug server port, defaults to 1111
```

## to-dos
- [ ] modularize majority of `index.js` (version `3.0.0`)
- [ ] tumblr checking & integration
- [ ] reddit integration (?)
- [ ] remake the discord bot to be public (version `4.0.0`)
- [x] debug server
- [x] improve frontend for better UX