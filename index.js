import { Client, Events, GatewayIntentBits, ActivityType, ActionRowBuilder, ButtonBuilder, ButtonStyle, EmbedBuilder, MessageFlags } from 'discord.js';
import { readFileSync, writeFileSync, existsSync, appendFileSync, readdirSync } from "node:fs";
import { screenshot } from "./utils/screenshot.js";
import { AtpAgent, RichText } from '@atproto/api';
import { createHash } from "node:crypto";
import { createServer } from "node:http";
import { diff } from 'deep-object-diff';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import { Server } from "socket.io";
import * as cheerio from "cheerio";
import express from "express";
import Emusks from "emusks";
import axios from "axios";

// constants
const newslettersURL = "https://toby.fangamer.com";
const twitterAccounts = { "39157744": "Toby Fox", "1148644417": "UNDERTALE/DELTARUNE" };
const bskyAccounts = { "did:plc:vshnclkqqguyg6xcz6q7g65k": "Toby Fox", "did:plc:ac4wblywohiikyarecf3ddpc": "UNDERTALE/DELTARUNE" };
const baseState = { newsletters: null, pages: {}, twitter: {}, bsky: {}, rolesMessage: null, queue: [] };
const __dirname = dirname(fileURLToPath(import.meta.url));
const app = express();
const server = createServer(app);
const io = new Server(server);

// essentials
const { version } = JSON.parse(readFileSync("package.json", "utf8"));
const config = JSON.parse(readFileSync("config.json", "utf8"));
const session = { start: Date.now(), version, checks: { newsletters: 0, pages: 0, twitter: 0, bluesky: 0 }, errors: { newsletters: 0, pages: 0, twitter: 0, bluesky: 0, others: 0 }, lastCheck: 0 };
const state = existsSync("state.json") ? { ...baseState, ...JSON.parse(readFileSync("state.json", "utf8")) } : baseState;
let changesMade = false;
const saveState = () => {
    io.emit("STATE", state);
    writeFileSync("state.json", JSON.stringify(state, null, 2));
    changesMade = false;
};
const sha256sum = data => createHash('sha256').update(data).digest('hex');
const logs = [];
const log = (data, error) => {
    const date = new Date();
    const loginfo = [date.getTime(), data, error ? (({ message, stack }) => ({ message, stack }))(error) : null];
    logs.push(loginfo);
    io.emit("LOG", loginfo);
    if (logs.length > 20) logs.shift();

    const timestamp = date.toISOString();
    if (error) {
        const errorStr = `[${timestamp}] ${data}: ${error.message}, ${error.stack || 'no stack trace available'}\n`;
        console.error(`[${timestamp}] ${data}:`, error);
        appendFileSync(`errors.log`, errorStr);
    } else {
        console.log(`[${timestamp}] ${data}`);
        appendFileSync(`logs.log`, `[${timestamp}] ${data}\n`);
    };
};
const sleep = (s) => new Promise(resolve => setTimeout(resolve, s * 1000));

// discord
const client = new Client({ intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMembers] });
const channels = {};
const getChannel = async (id) => {
    if (channels[id]) return channels[id];
    const channel = await client.channels.fetch(id);
    channels[id] = channel;
    return channel;
};
client.on(Events.ClientReady, async () => {
    try {
        log(`Logged into Discord as ${client.user.tag}!`)
        client.user.setActivity('stalking Toby Fox 👀', { type: ActivityType.Watching });
        const channel = await getChannel(config.channels.info);
        if (state.rolesMessage) {
            try {
                const message = await channel.messages.fetch(state.rolesMessage);
                if (message) return;
            } catch (e) {
                log("Roles message no longer exists, recreating", e);
                session.errors.others++;
            };
        };
        const row = new ActionRowBuilder();
        for (const role in config.roles) {
            const [_, emoji] = config.roles[role];
            const button = new ButtonBuilder()
                .setCustomId(role)
                .setLabel(role)
                .setEmoji(emoji)
                .setStyle(ButtonStyle.Success);
            row.addComponents(button);
        };
        const message = await channel.send({ content: "come get yo roles yall\n> by default, you receive all notifications, feel free to remove/add any!", components: [row] });
        state.rolesMessage = message.id;
        changesMade = true;
    } catch (e) {
        log("Failed to start Discord bot", e);
        session.errors.others++;
    };
});
client.on(Events.GuildMemberAdd, async member => {
    try {
        const channel = await getChannel(config.channels.logs);
        const embed = new EmbedBuilder()
            .setColor(0x40ff40)
            .setDescription(`<@${member.id}> (\`${member.id}\`) joined!`);
        await channel.send({ embeds: [embed] });
        await member.roles.add(Object.values(config.roles).map(r => r[0]), "joined");
    } catch (e) {
        log("Failed to log user joining", e);
        session.errors.others++;
    };
});
client.on(Events.GuildMemberRemove, async member => {
    try {
        const channel = await getChannel(config.channels.logs);
        const embed = new EmbedBuilder()
            .setColor(0xff4040)
            .setDescription(`**${member.user.username}** (\`${member.id}\`) left.`);
        await channel.send({ embeds: [embed] });
    } catch (e) {
        log("Failed to log user leaving", e);
        session.errors.others++;
    };
});
client.on(Events.InteractionCreate, async interaction => {
    try {
        if (!interaction.isButton()) return;
        const role = interaction.customId;
        if (!config.roles[role]) return;
        const [roleId, _] = config.roles[role];
        const member = interaction.member;
        if (member.roles.cache.has(roleId)) {
            await member.roles.remove(roleId, "requested");
            const embed = new EmbedBuilder()
                .setColor(0xff4040)
                .setDescription(`<@&${roleId}> removed!`);
            await interaction.reply({ embeds: [embed], flags: [MessageFlags.Ephemeral] });
        } else {
            await member.roles.add(roleId, "requested");
            const embed = new EmbedBuilder()
                .setColor(0x40ff40)
                .setDescription(`<@&${roleId}> added!`);
            await interaction.reply({ embeds: [embed], flags: [MessageFlags.Ephemeral] });
        };
    } catch (e) {
        log("Failed to add/remove role", e);
        session.errors.others++;
    };
});

// socials
const twitter = new Emusks();
const bsky = new AtpAgent({ service: 'https://bsky.social' });
let runningHandler = null;
const postHandler = async () => {
    while (state.queue.length > 0) {
        log(`Queue size: ${state.queue.length}`);
        const { content, media, socials } = state.queue.shift();
        const image = (media && existsSync(media)) ? readFileSync(media) : undefined;
        let toPush = undefined;
        if (socials.includes("twitter")) {
            try {
                const mediaIds = [];
                if (media) {
                    const twitterMedia = await twitter.media.create(image);
                    mediaIds.push(twitterMedia.media_id);
                };
                const response = await twitter.tweets.create(content, { mediaIds });
                log(`Tweeted! ${response.id}`);
            } catch (err) {
                log("Failed to tweet", err);
                if (!toPush) toPush = { content, media, socials: ["twitter"] };
                else toPush.socials.push("twitter");
                session.errors.others++;
            };
        };
        if (socials.includes("bluesky")) {
            try {
                const rt = new RichText({ text: content, });
                await rt.detectFacets(bsky);
                const record = {
                    text: rt.text,
                    facets: rt.facets
                };
                if (media) {
                    const upload = await bsky.uploadBlob(image, { encoding: "image/png" });
                    record.embed = {
                        $type: 'app.bsky.embed.images',
                        images: [{ image: upload.data.blob, alt: "" }]
                    };
                };
                const response = await bsky.post(record);
                log(`Posted to Bluesky! ${response.uri}`);
            } catch (err) {
                log("Failed to post to Bluesky", err);
                if (!toPush) toPush = { content, media, socials: ["bluesky"] };
                else toPush.socials.push("bluesky");
                session.errors.others++;
            };
        };
        if (toPush) state.queue.push(toPush);
        saveState();
        await sleep(60);
    };
    log(`Queue empty!`);
    runningHandler = null;
};
const post = (content, media, socials = ["twitter", "bluesky"]) => {
    state.queue.push({ content, media, socials });
    saveState();
    if (!runningHandler) runningHandler = postHandler();
};

// scrapers
const checkNewsletters = async () => {
    try {
        const newslettersPage = await axios.get(`${newslettersURL}/newsletters`);
        const $ = cheerio.load(newslettersPage.data);
        const articles = $("#articles").children().get().reverse();
        const firstCheck = state.newsletters == null;
        if (firstCheck) {
            state.newsletters = [];
            for (let i = 0; i < articles.length - 1; i++) state.newsletters.push(articles[i].attribs['href']);
            changesMade = true;
        };
        for (const article of articles) {
            const href = article.attribs['href'];
            if (!state.newsletters.includes(href)) {
                const url = `${newslettersURL}${href}`;
                const [title, description] = $(article).text().split('\n').map(s => s.trim()).filter(Boolean);
                log(`New newsletter! ${url}\n    ${title}\n    ${description}`);
                const newsletterScreenshot = await screenshot(url, { filename: href.split("/").filter(Boolean).at(-1), width: 720, height: 720, progress: log });
                const channel = await getChannel(config.channels.newsletters);
                const msg = await channel.send({ content: `# ${firstCheck ? "Last newsletter:" : "New newsletter!"}\n**${url}**\n-# ||<@&${config.roles.newsletters[0]}>||`, files: [newsletterScreenshot] });
                msg.crosspost().catch(() => { });
                post(`${firstCheck ? "Last Toby Fox newsletter:" : "New Toby Fox newsletter!"} #deltarune\n${url}`, newsletterScreenshot);
                state.newsletters.push(href);
                changesMade = true;
            };
        };
        session.checks.newsletters++;
    } catch (e) {
        log("Error checking newsletters", e);
        session.errors.newsletters++;
    };
};

const checkPages = async () => {
    for (const { url, name, settings } of config.pages) {
        try {
            const page = await axios.get(url).then(r => r.data);
            const pageSha256 = sha256sum(page);
            const firstCheck = state.pages[url] == null;
            if (pageSha256 !== state.pages[url]) {
                log(`Page ${url} updated!`);
                const screenshotPath = await screenshot(url, { progress: log, ...settings });
                const channel = await getChannel(config.channels.pages);
                const message = await channel.send({ content: `# [${name} ${firstCheck ? "currently:" : "updated!"}](${url})\n-# ||<@&${config.roles.pages[0]}>||`, files: [screenshotPath] });
                message.crosspost().catch(() => { });
                post(`${name} ${firstCheck ? "currently:" : "updated!"} #deltarune\n${url}`, screenshotPath);
                state.pages[url] = pageSha256;
                changesMade = true;
            };
        } catch (e) {
            log(`Error checking page ${name}`, e);
            session.errors.pages++;
        };
    };
    session.checks.pages++;
};

const checkTwitter = async () => {
    const cookies = [{ name: 'auth_token', value: process.env.TWITTER_AUTH, domain: '.x.com', path: '/', httpOnly: true, secure: true, sameSite: 'None' }, { name: "night_mode", value: "2", domain: ".x.com", path: "/" }];
    for (const account in twitterAccounts) {
        if (!state.twitter[account]) state.twitter[account] = { profile: null, tweets: null };
        try {
            const profile = await twitter.users.get(account);
            const profileInfo = (({ name, username, description, banner, url, location, birthdate, profile_picture }) => ({ name, username, description, banner, url, location, birthdate, profile_picture }))(profile);
            const firstProfileCheck = state.twitter[account].profile == null;
            if (firstProfileCheck) state.twitter[account].profile = {};
            const changes = diff(state.twitter[account].profile, profileInfo);
            if (Object.keys(changes).length > 0) {
                log(`${twitterAccounts[account]}'s Twitter profile ${firstProfileCheck ? "initial sync" : `updated! (${Object.keys(changes).join(", ")})`}\n${JSON.stringify(changes)}`);
                const url = `https://x.com/${profileInfo.username}`;
                const profileScreenshot = await screenshot(url, { progress: log, element: 'div:has(> div > [data-testid="UserName"])', cookies });
                const channel = await getChannel(config.channels.twitter);
                const message = await channel.send({ content: `# [${twitterAccounts[account]}'s ${firstProfileCheck ? "current Twitter profile:" : "Twitter profile updated!"}](<${url}>)\n-# ||<@&${config.roles.twitter[0]}>||`, files: [profileScreenshot] });
                message.crosspost().catch(() => { });
                post(`${twitterAccounts[account]}'s ${firstProfileCheck ? "current Twitter profile:" : "Twitter profile updated!"} #deltarune\n${url}`, profileScreenshot);
                state.twitter[account].profile = profileInfo;
                changesMade = true;
            };
        } catch (e) {
            log(`Error checking Twitter profile for ${twitterAccounts[account]}`, e);
            session.errors.twitter++;
        };

        try {
            const { tweets = [] } = (await twitter.users.replies(account)) || {};
            const firstTweetCheck = state.twitter[account].tweets == null;
            if (firstTweetCheck) {
                state.twitter[account].tweets = [];
                const matching = tweets.filter(t => String(t.user?.id) === account && Date.now() - new Date(t.created_at).getTime() < config.maxage * 1000);
                if (matching.length > 1) {
                    state.twitter[account].tweets.push(...matching.slice(1).map(t => t.id));
                    changesMade = true;
                };
            };
            for (let i = tweets.length - 1; i >= 0; i--) {
                const tweet = tweets[i];
                if (String(tweet.user?.id) === account && Date.now() - new Date(tweet.created_at).getTime() < config.maxage * 1000 && !state.twitter[account].tweets.includes(tweet.id)) {
                    const url = `https://x.com/i/status/${tweet.id}`;
                    log(`New tweet by ${twitterAccounts[account]}! ${url}`);
                    const tweetScreenshot = await screenshot(url, { progress: log, element: 'article[data-testid="tweet"]', cookies });
                    const channel = await getChannel(config.channels.twitter);
                    const message = await channel.send({ content: `# ${firstTweetCheck ? "Last" : "New"} tweet by ${twitterAccounts[account]}${firstTweetCheck ? ":" : "!"}\n**<${url}>**\n-# ||<@&${config.roles.twitter[0]}>||`, files: [tweetScreenshot] });
                    message.crosspost().catch(() => { });
                    post(`${firstTweetCheck ? "Last" : "New"} tweet by ${twitterAccounts[account]}${firstTweetCheck ? ":" : "!"} #deltarune\n${url}`, tweetScreenshot, ["bluesky"]);
                    await twitter.tweets.retweet(tweet.id).catch(e => {
                        if (e.message.includes("You have already retweeted this Tweet.")) return;
                        log(`Error retweeting tweet ${tweet.id} by ${twitterAccounts[account]}`, e);
                        session.errors.twitter++;
                    });
                    state.twitter[account].tweets.push(tweet.id);
                    changesMade = true;
                };
            };
        } catch (e) {
            log(`Error checking ${twitterAccounts[account]}'s Tweets`, e);
            session.errors.twitter++;
        };
    };
    session.checks.twitter++;
};

const checkBluesky = async () => {
    const evalme = async (page) => {
        await page.goto('https://bsky.app/');
        await page.evaluate((ACCOUNT) => localStorage.setItem('BSKY_STORAGE', JSON.stringify({ colorMode: "dark", darkTheme: "dark", session: { accounts: [ACCOUNT], currentAccount: ACCOUNT }, reminders: {}, languagePrefs: { primaryLanguage: "en", contentLanguages: ["en"], postLanguage: "en", postLanguageHistory: ["en"], appLanguage: "en" }, requireAltTextEnabled: false, largeAltBadgeEnabled: false, externalEmbeds: {}, mutedThreads: [], invites: { copiedInvites: [] }, onboarding: { step: "Home" }, hiddenPosts: [], pdsAddressHistory: [], disableHaptics: false, disableAutoplay: false, kawaii: false, hasCheckedForStarterPack: true, subtitlesEnabled: true, trendingDisabled: false, trendingVideoDisabled: false })), { service: "https://bsky.social/", signupQueued: false, pdsUrl: "https://fibercap.us-west.host.bsky.network/", isSelfHosted: false, ...bsky.session });
    };
    for (const account in bskyAccounts) {
        if (!state.bsky[account]) state.bsky[account] = { profile: null, posts: null };
        try {
            const profile = await bsky.getProfile({ actor: account });
            const profileInfo = (({ handle, displayName, avatar, description, banner }) => ({ handle, displayName, avatar, description, banner }))(profile.data);
            const firstProfileCheck = state.bsky[account].profile == null;
            if (firstProfileCheck) state.bsky[account].profile = {};
            const changes = diff(state.bsky[account].profile, profileInfo);
            if (Object.keys(changes).length > 0) {
                log(`Bluesky profile for ${bskyAccounts[account]} ${firstProfileCheck ? "initial sync" : `updated! (${Object.keys(changes).join(", ")})`}\n${JSON.stringify(changes)}`);
                const url = `https://bsky.app/profile/${profileInfo.handle}`;
                const profileScreenshot = await screenshot(url, { progress: log, element: 'div:has(> div > [data-testid="userBannerImage"])', evalme });
                const channel = await getChannel(config.channels.bluesky);
                const message = await channel.send({ content: `# [${bskyAccounts[account]}'s ${firstProfileCheck ? "current Bluesky profile:" : "Bluesky profile updated!"}](<${url}>)\n-# ||<@&${config.roles.bluesky[0]}>||`, files: [profileScreenshot] });
                message.crosspost().catch(() => { });
                post(`${bskyAccounts[account]}'s ${firstProfileCheck ? "current Bluesky profile:" : "Bluesky profile updated!"} #deltarune\n${url}`, profileScreenshot);
                state.bsky[account].profile = profileInfo;
                changesMade = true;
            };
        } catch (e) {
            log(`Error checking ${bskyAccounts[account]}'s Bluesky profile`, e);
            session.errors.bluesky++;
        };

        try {
            const authorFeed = await bsky.getAuthorFeed({ actor: account });
            const posts = authorFeed.data?.feed ?? [];
            const firstPostCheck = state.bsky[account].posts == null;
            if (firstPostCheck) {
                state.bsky[account].posts = [];
                const matching = posts.filter(entry => entry.post?.author?.did === account && Date.now() - new Date(entry.post?.indexedAt).getTime() < config.maxage * 1000);
                if (matching.length > 1) {
                    state.bsky[account].posts.push(...matching.slice(1).map(entry => entry.post?.uri));
                    changesMade = true;
                };
            };
            for (let i = posts.length - 1; i >= 0; i--) {
                const entry = posts[i];
                if (entry.post?.author?.did === account && Date.now() - new Date(entry.post?.indexedAt).getTime() < config.maxage * 1000 && !state.bsky[account].posts.includes(entry.post?.uri)) {
                    const postURL = `https://bsky.app/profile/${entry.post?.author?.handle}/post/${entry.post?.uri.split('/').pop()}`;
                    log(`New Bluesky post by ${bskyAccounts[account]}! ${postURL}`);
                    const postScreenshot = await screenshot(postURL, { progress: log, element: `[data-testid="postThreadItem-by-${entry.post?.author?.handle}"]`, evalme });
                    const channel = await getChannel(config.channels.bluesky);
                    const message = await channel.send({ content: `# ${firstPostCheck ? "Last" : "New"} Bluesky post by ${bskyAccounts[account]}${firstPostCheck ? ":" : "!"}\n**<${postURL}>**\n-# ||<@&${config.roles.bluesky[0]}>||`, files: [postScreenshot] });
                    message.crosspost().catch(() => { });
                    post(`${firstPostCheck ? "Last" : "New"} Bluesky post by ${bskyAccounts[account]}${firstPostCheck ? ":" : "!"} #deltarune\n${postURL}`, postScreenshot, ["twitter"]);
                    await bsky.repost(entry.post.uri, entry.post.cid).catch(e => {
                        log(`Error reposting Bluesky post by ${bskyAccounts[account]}`, e);
                        session.errors.bluesky++;
                    });
                    state.bsky[account].posts.push(entry.post?.uri);
                    changesMade = true;
                };
            };
        } catch (e) {
            log(`Error checking ${bskyAccounts[account]}'s Bluesky posts`, e);
            session.errors.bluesky++;
        };
    };
    session.checks.bluesky++;
};

// initializer
const check = async () => {
    try {
        await checkNewsletters();
        await checkPages();
        await checkTwitter();
        await checkBluesky();
    } catch (e) {
        log("Error in check loop", e);
        session.errors.others++;
    } finally {
        session.lastCheck = Date.now();
        if (changesMade) saveState();
        io.emit("SESSION", session);
        setTimeout(check, config.interval * 1000);
    };
};

app.use(express.static("public"));
app.use("/screenshots", express.static("screenshots"));
app.get("/screenshots", (_, res) => res.json(existsSync("./screenshots") ? readdirSync("./screenshots") : []));
app.get("/stats", (_, res) => res.json({ config, state, session }));
app.get("/logs.log", (_, res) => res.sendFile(join(__dirname, "logs.log")));
app.get("/errors.log", (_, res) => res.sendFile(join(__dirname, "errors.log")));
app.get("/logs", (_, res) => res.json(logs));
io.on("connection", sock => {
    sock.emit("LOGS", logs);
    sock.emit("STATE", state);
    sock.emit("SESSION", session);
});

(async () => {
    log("Hello World!");
    const PORT = process.env.PORT || 1111; // WHETHER 11 HOURS OR 11 YEARS, DELTARUNE WILL BE WAITING.
    server.listen(PORT, () => log(`Live on http://127.0.0.1:${PORT}/`));
    await client.login(process.env.DISCORD_TOKEN);
    await twitter.login(process.env.TWITTER_AUTH);
    await bsky.login({ identifier: process.env.BSKY_HANDLE, password: process.env.BSKY_PASSWORD });
    if (state.queue.length > 0 && !runningHandler) runningHandler = postHandler();
    check();
})();