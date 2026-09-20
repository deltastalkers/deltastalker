import { Client, Events, GatewayIntentBits, ActivityType, ActionRowBuilder, ButtonBuilder, ButtonStyle, EmbedBuilder, MessageFlags } from 'discord.js';
import { readFileSync, writeFileSync, existsSync, readdirSync } from "node:fs";
import { createHash, timingSafeEqual } from "node:crypto";
import { AtpAgent, RichText } from '@atproto/api';
import screenshot from "./utils/screenshot.js";
import { createServer } from "node:http";
import { diff } from 'deep-object-diff';
import posts from './utils/posts.js';
import Logger from "./utils/log.js";
import { Server } from "socket.io";
import * as cheerio from "cheerio";
import express from "express";
import Emusks from "emusks";
import axios from "axios";

// constants
const newslettersURL = "https://toby.fangamer.com";
const twitterAccounts = { "39157744": "Toby Fox", "1148644417": "UNDERTALE/DELTARUNE" };
const bskyAccounts = { "did:plc:vshnclkqqguyg6xcz6q7g65k": "Toby Fox", "did:plc:ac4wblywohiikyarecf3ddpc": "UNDERTALE/DELTARUNE" };
const stateSchema = { newsletters: null, pages: {}, twitter: {}, bsky: {}, rolesMessage: null, queue: [] };
const app = express();
const server = createServer(app);
const io = new Server(server);

// essentials
const { version } = JSON.parse(readFileSync("package.json", "utf8"));
const config = JSON.parse(readFileSync("config.json", "utf8"));
const session = { start: new Date().toISOString(), lastCheck: null, checks: { newsletters: 0, pages: 0, twitter: 0, bluesky: 0 }, errors: { newsletters: 0, pages: 0, twitter: 0, bluesky: 0, others: 0 }, version };
const state = existsSync("state.json") ? { ...stateSchema, ...JSON.parse(readFileSync("state.json", "utf8")) } : stateSchema;
let changesMade = false;
const saveState = () => {
    io.emit("STATE", state);
    writeFileSync("state.json", JSON.stringify(state, null, 2));
    changesMade = false;
};
const sha256sum = data => createHash('sha256').update(data).digest('hex');
const parseError = error => error ? (({ message, stack }) => ({ message, stack }))(error) : error;
const logger = new Logger({
    maxLogs: config.maxLogs || 100,
    logFile: `./logs/${session.start.replace(/[:.]/g, "_")}.log`,
    categories: ["OTHERS", "SCREENSHOT", "DISCORD", "POSTS", "NEWSLETTERS", "PAGES", "TWITTER", "BSKY"],
    onUpdate: (log) => io.emit("LOG", { ...log, error: parseError(log.error) })
});
const screenshotLog = (data, error) => logger.log(data, { error, cat: 1 });
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
        logger.log(`Logged into Discord as ${client.user.tag}!`, { cat: 2 });
        client.user.setActivity('stalking Toby Fox 👀', { type: ActivityType.Watching });
        const channel = await getChannel(config.channels.info);
        if (state.rolesMessage) {
            try {
                const message = await channel.messages.fetch(state.rolesMessage);
                if (message) return;
            } catch (error) {
                logger.log("Roles message no longer exists, recreating", { error, cat: 2 });
                session.errors.others++;
            };
        };
        const roleList = [];
        const row = new ActionRowBuilder();
        for (const role in config.roles) {
            const [id, emoji, description] = config.roles[role];
            roleList.push(`**${emoji} <@&${id}>:** ${description}`);
            const button = new ButtonBuilder()
                .setCustomId(role)
                .setLabel(role)
                .setEmoji(emoji)
                .setStyle(ButtonStyle.Success);
            row.addComponents(button);
        };
        const message = await channel.send({ content: `# notifications:\n- ${roleList.join("\n- ")}\n-# upon joining, you automatically receive all notifications, feel free to change anything!`, components: [row] });
        state.rolesMessage = message.id;
        changesMade = true;
    } catch (error) {
        logger.log("Failed to start Discord bot", { error, cat: 2 });
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
    } catch (error) {
        logger.log("Failed to log user joining", { error, cat: 2 });
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
    } catch (error) {
        logger.log("Failed to log user leaving", { error, cat: 2 });
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
    } catch (error) {
        logger.log("Failed to add/remove role", { error, cat: 2 });
        session.errors.others++;
    };
});

// socials
const twitter = new Emusks();
const bsky = new AtpAgent({ service: 'https://bsky.social' });
let runningHandler = null;
const postHandler = async () => {
    while (state.queue.length > 0) {
        logger.log(`Queue size: ${state.queue.length}`, { cat: 3 });
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
                logger.log(`Tweeted! (ID: ${response.id})`, { cat: 3 });
            } catch (error) {
                logger.log("Failed to tweet", { error, cat: 3 });
                if (!toPush) toPush = { content, media, socials: ["twitter"] };
                else toPush.socials.push("twitter");
                session.errors.others++;
            };
        };
        if (socials.includes("bsky")) {
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
                logger.log(`Posted to Bluesky! (URI: ${response.uri})`, { cat: 3 });
            } catch (error) {
                logger.log("Failed to post to Bluesky", { error, cat: 3 });
                if (!toPush) toPush = { content, media, socials: ["bsky"] };
                else toPush.socials.push("bsky");
                session.errors.others++;
            };
        };
        if (toPush) state.queue.push(toPush);
        saveState();
        await sleep(60);
    };
    logger.log(`Queue empty!`, { cat: 3 });
    runningHandler = null;
};
const post = (content, media, socials = ["twitter", "bsky"]) => {
    state.queue.push({ content, media, socials });
    saveState();
    if (!runningHandler) runningHandler = postHandler();
};

// checkers
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
                logger.log(`New newsletter! ${url}\n    ${title}\n    ${description}`, { cat: 4 });
                const newsletterScreenshot = await screenshot(url, { filename: href.split("/").filter(Boolean).at(-1), width: 720, height: 720, progress: screenshotLog });
                const { discord, socials } = posts.newsletter({ firstCheck, url, title, description, image: newsletterScreenshot });
                const channel = await getChannel(config.channels.newsletters);
                const msg = await channel.send({ content: `-# ||<@&${config.roles.newsletters[0]}>||`, ...discord });
                msg.crosspost().catch(() => { });
                post(...socials);
                state.newsletters.push(href);
                changesMade = true;
            };
        };
        session.checks.newsletters++;
    } catch (error) {
        logger.log("Error checking newsletters", { error, cat: 4 });
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
                logger.log(`Page ${url} updated!`, { cat: 5 });
                const screenshotPath = await screenshot(url, { progress: screenshotLog, ...settings });
                const { discord, socials } = posts.page({ firstCheck, url, name, image: screenshotPath });
                const channel = await getChannel(config.channels.pages);
                const message = await channel.send({ content: `-# ||<@&${config.roles.pages[0]}>||`, ...discord });
                message.crosspost().catch(() => { });
                post(...socials);
                state.pages[url] = pageSha256;
                changesMade = true;
            };
        } catch (error) {
            logger.log(`Error checking page ${name}`, { error, cat: 5 });
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
            if (!profileInfo.username) throw new Error(`Invalid profile: ${JSON.stringify(profile)}`);
            const firstProfileCheck = state.twitter[account].profile == null;
            if (firstProfileCheck) state.twitter[account].profile = {};
            const changes = diff(state.twitter[account].profile, profileInfo);
            if (Object.keys(changes).length > 0) {
                logger.log(`${twitterAccounts[account]}'s Twitter profile ${firstProfileCheck ? "initial sync" : `updated! (${Object.keys(changes).join(", ")})`}\n${JSON.stringify(changes)}`, { cat: 6 });
                const url = `https://x.com/${profileInfo.username}`;
                const profileScreenshot = await screenshot(url, { progress: screenshotLog, element: 'div:has(> div > [data-testid="UserName"])', cookies });
                const { discord, socials } = posts.twitterProfile({ name: twitterAccounts[account], firstProfileCheck, url, image: profileScreenshot });
                const channel = await getChannel(config.channels.twitter);
                const message = await channel.send({ content: `-# ||<@&${config.roles.twitter[0]}>||`, ...discord });
                message.crosspost().catch(() => { });
                post(...socials);
                state.twitter[account].profile = profileInfo;
                changesMade = true;
            };
        } catch (error) {
            logger.log(`Error checking Twitter profile for ${twitterAccounts[account]}`, { error, cat: 6 });
            session.errors.twitter++;
        };

        try {
            const { tweets = [] } = (await twitter.users.replies(account)) || {};
            const validateTweet = tweet => tweet.retweeting == null && String(tweet.user?.id) === account && Date.now() - new Date(tweet.created_at).getTime() < config.maxAge * 1000;
            const firstTweetCheck = state.twitter[account].tweets == null;
            if (firstTweetCheck) {
                state.twitter[account].tweets = [];
                const matching = tweets.filter(validateTweet);
                if (matching.length > 1) {
                    state.twitter[account].tweets.push(...matching.slice(1).map(t => t.id));
                    changesMade = true;
                };
            };
            for (let i = tweets.length - 1; i >= 0; i--) {
                const tweet = tweets[i];
                if (validateTweet(tweet) && !state.twitter[account].tweets.includes(tweet.id)) {
                    const url = `https://x.com/i/status/${tweet.id}`;
                    logger.log(`New tweet by ${twitterAccounts[account]}! ${url}`, { cat: 6 });
                    const tweetScreenshot = await screenshot(url, { progress: screenshotLog, element: 'article[data-testid="tweet"]', cookies });
                    const { discord, socials } = posts.twitterPost({ firstTweetCheck, name: twitterAccounts[account], url, image: tweetScreenshot });
                    const channel = await getChannel(config.channels.twitter);
                    const message = await channel.send({ content: `-# ||<@&${config.roles.twitter[0]}>||`, ...discord });
                    message.crosspost().catch(() => { });
                    post(...socials, ["bsky"]);
                    twitter.tweets.retweet(tweet.id).catch(error => {
                        if (error.message.includes("You have already retweeted this Tweet.")) return;
                        logger.log(`Error retweeting tweet ${tweet.id} by ${twitterAccounts[account]}`, { error, cat: 6 });
                        session.errors.twitter++;
                    });
                    state.twitter[account].tweets.push(tweet.id);
                    changesMade = true;
                };
            };
        } catch (error) {
            logger.log(`Error checking ${twitterAccounts[account]}'s Tweets`, { error, cat: 6 });
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
            if (!profileInfo.handle) throw new Error(`Invalid profile: ${JSON.stringify(profile)}`);
            const firstProfileCheck = state.bsky[account].profile == null;
            if (firstProfileCheck) state.bsky[account].profile = {};
            const changes = diff(state.bsky[account].profile, profileInfo);
            if (Object.keys(changes).length > 0) {
                logger.log(`Bluesky profile for ${bskyAccounts[account]} ${firstProfileCheck ? "initial sync" : `updated! (${Object.keys(changes).join(", ")})`}\n${JSON.stringify(changes)}`, { cat: 7 });
                const url = `https://bsky.app/profile/${profileInfo.handle}`;
                const profileScreenshot = await screenshot(url, { progress: screenshotLog, element: 'div:has(> div > [data-testid="userBannerImage"])', evalme });
                const { discord, socials } = posts.bskyProfile({ name: bskyAccounts[account], firstProfileCheck, url, image: profileScreenshot });
                const channel = await getChannel(config.channels.bluesky);
                const message = await channel.send({ content: `-# ||<@&${config.roles.bluesky[0]}>||`, ...discord });
                message.crosspost().catch(() => { });
                post(...socials);
                state.bsky[account].profile = profileInfo;
                changesMade = true;
            };
        } catch (error) {
            logger.log(`Error checking ${bskyAccounts[account]}'s Bluesky profile`, { error, cat: 7 });
            session.errors.bluesky++;
        };

        try {
            const authorFeed = await bsky.getAuthorFeed({ actor: account });
            const validateEntry = entry => entry.post?.author?.did === account && Date.now() - new Date(entry.post?.indexedAt).getTime() < config.maxAge * 1000;
            const authorPosts = authorFeed.data?.feed ?? [];
            const firstPostCheck = state.bsky[account].posts == null;
            if (firstPostCheck) {
                state.bsky[account].posts = [];
                const matching = authorPosts.filter(validateEntry);
                if (matching.length > 1) {
                    state.bsky[account].posts.push(...matching.slice(1).map(entry => entry.post?.uri));
                    changesMade = true;
                };
            };
            for (let i = authorPosts.length - 1; i >= 0; i--) {
                const entry = authorPosts[i];
                if (validateEntry(entry) && !state.bsky[account].posts.includes(entry.post?.uri)) {
                    const url = `https://bsky.app/profile/${entry.post?.author?.handle}/post/${entry.post?.uri.split('/').pop()}`;
                    logger.log(`New Bluesky post by ${bskyAccounts[account]}! ${url}`, { cat: 7 });
                    const postScreenshot = await screenshot(url, { progress: screenshotLog, element: `[data-testid="postThreadItem-by-${entry.post?.author?.handle}"]`, evalme });
                    const { discord, socials } = posts.bskyPost({ firstPostCheck, name: bskyAccounts[account], url, image: postScreenshot })
                    const channel = await getChannel(config.channels.bluesky);
                    const message = await channel.send({ content: `-# ||<@&${config.roles.bluesky[0]}>||`, ...discord });
                    message.crosspost().catch(() => { });
                    post(...socials, ["twitter"]);
                    bsky.repost(entry.post.uri, entry.post.cid).catch(error => {
                        logger.log(`Error reposting Bluesky post by ${bskyAccounts[account]}`, { error, cat: 7 });
                        session.errors.bluesky++;
                    });
                    state.bsky[account].posts.push(entry.post?.uri);
                    changesMade = true;
                };
            };
        } catch (error) {
            logger.log(`Error checking ${bskyAccounts[account]}'s Bluesky posts`, { error, cat: 7 });
            session.errors.bluesky++;
        };
    };
    session.checks.bluesky++;
};

// server
const attemptLog = {};
const authenticate = (authHeader) => {
    if (!authHeader || !authHeader.startsWith('Basic ')) return false;
    const credentials = Buffer.from(authHeader.split(' ')[1], 'base64').toString('utf-8');
    const inputBuf = Buffer.from(sha256sum(credentials));
    const expectedBuf = Buffer.from(sha256sum(`${process.env.USERNAME}:${process.env.PASSWORD}`) || '');
    return inputBuf.length === expectedBuf.length && timingSafeEqual(inputBuf, expectedBuf);
};

app.get("/health", (_, res) => res.sendStatus(200));
app.use((req, res, next) => {
    if (authenticate(req.headers.authorization)) return next();
    res.setHeader('WWW-Authenticate', 'Basic realm="Secure Area"');
    const ip = req.headers['cf-connecting-ip'] || req.ip;
    const now = Date.now();
    if (!attemptLog[ip]) attemptLog[ip] = [];
    attemptLog[ip] = attemptLog[ip].filter(timestamp => (now - timestamp) < config.server.window * 1000);
    if (attemptLog[ip].length >= config.server.maxAttempts) return res.sendStatus(429);
    attemptLog[ip].push(now);
    return res.sendStatus(401);
});
io.use((sock, next) => next(authenticate(sock.handshake.headers.authorization) ? undefined : new Error("Unauthorized")));

app.use(express.static("public"));
for (const path of ["screenshots", "logs"]) {
    app.use(`/${path}`, express.static(path));
    app.get(`/${path}`, (_, res) => res.json(existsSync(`./${path}`) ? readdirSync(`./${path}`) : []));
};

const requestSafeLogs = () => logger.logs.map(log => ({ ...log, error: parseError(log.error) }));
app.get("/static", (_, res) => res.json({ config, state, session, logs: requestSafeLogs() }));
io.on("connection", sock => {
    sock.emit("LOGS", requestSafeLogs());
    sock.emit("STATE", state);
    sock.emit("SESSION", session);
    sock.emit("CONFIG", config);
    sock.on("CLEAR_LOGS", () => {
        logger.logs.length = 0;
        io.emit("LOGS", requestSafeLogs());
    });
});

setInterval(() => {
    const now = Date.now();
    for (const ip in attemptLog) {
        attemptLog[ip] = attemptLog[ip].filter(timestamp => (now - timestamp) < config.server.window * 1000);
        if (attemptLog[ip].length === 0) delete attemptLog[ip];
    };
}, (config.server.window * 1000) / 2);

// initializer
const check = async () => {
    try {
        await checkNewsletters();
        await checkPages();
        await checkTwitter();
        await checkBluesky();
    } catch (error) {
        logger.log("Error in check loop", { error });
        session.errors.others++;
    } finally {
        session.lastCheck = Date.now();
        if (changesMade) saveState();
        io.emit("SESSION", session);
        setTimeout(check, config.interval * 1000);
    };
};

(async () => {
    logger.log("Hello World!");
    const PORT = Number(process.env.PORT) || 1111; // WHETHER 11 HOURS OR 11 YEARS, DELTARUNE WILL BE WAITING.
    server.listen(PORT, () => logger.log(`Live on http://localhost:${PORT}`));
    await client.login(process.env.DISCORD_TOKEN);
    await twitter.login(process.env.TWITTER_AUTH);
    await bsky.login({ identifier: process.env.BSKY_HANDLE, password: process.env.BSKY_PASSWORD });
    if (state.queue.length > 0 && !runningHandler) runningHandler = postHandler();
    check();
})();