import { Client, Events, GatewayIntentBits, ActivityType, ActionRowBuilder, ButtonBuilder, ButtonStyle, EmbedBuilder, MessageFlags } from 'discord.js';
import { readFileSync, writeFileSync, existsSync, appendFileSync, readdirSync } from "fs";
import { screenshot } from "./utils/screenshot.js";
import { AtpAgent, RichText } from '@atproto/api';
import { createHash } from "node:crypto";
import * as cheerio from "cheerio";
import express from "express";
import Emusks from "emusks";
import axios from "axios";

// constants
const newslettersURL = "https://toby.fangamer.com";
const progressURL = "https://deltarune.com/7b/";
const twitterAccounts = { "39157744": "Toby Fox", "1148644417": "UNDERTALE/DELTARUNE" };
const bskyAccounts = { "did:plc:vshnclkqqguyg6xcz6q7g65k": "Toby Fox", "did:plc:ac4wblywohiikyarecf3ddpc": "UNDERTALE/DELTARUNE" };
const baseState = { newsletters: [], progress: null, twitter: {}, bsky: {}, rolesMessage: null, queue: [] };

// essentials
const config = JSON.parse(readFileSync("config.json", "utf8"));
const session = { checks: { newsletters: 0, progress: 0, twitter: 0, bluesky: 0 }, errors: { newsletters: 0, progress: 0, twitter: 0, bluesky: 0, others: 0 }, lastCheck: 0 };
const state = existsSync("state.json") ? { ...baseState, ...JSON.parse(readFileSync("state.json", "utf8")) } : baseState;
let changesMade = false;
const saveState = () => {
    writeFileSync("state.json", JSON.stringify(state, null, 2));
    changesMade = false;
};
const sha256sum = data => createHash('sha256').update(data).digest('hex');
const log = (data, error) => {
    const timestamp = new Date().toISOString();
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
    // log("Checking for new newsletters...");
    try {
        const newslettersPage = await axios.get(`${newslettersURL}/newsletters`);
        const $ = cheerio.load(newslettersPage.data);
        for (const article of $("#articles").children().get().reverse()) {
            const href = article.attribs['href'];
            if (!state.newsletters.includes(href)) {
                const url = `${newslettersURL}${href}`;
                const [title, description] = $(article).text().split('\n').map(s => s.trim()).filter(Boolean);
                log(`NEW NEWSLETTER! ${url}\n    ${title}\n    ${description}`);
                const newsletterScreenshot = await screenshot(url, { filename: newsletter.split("/").filter(i => i).at(-1), width: 720, height: 720, progress: log });
                const channel = await getChannel(config.channels.newsletters);
                const msg = await channel.send({ content: `# ${config.firstrun ? "Last newsletter:" : "New newsletter!"}\n**${url}**\n-# ||<@&${config.roles.newsletters[0]}>||`, files: [newsletterScreenshot] });
                msg.crosspost().catch(() => { });
                post(`${config.firstrun ? "Last Toby Fox newsletter:" : "New Toby Fox newsletter!"} #deltarune\n${url}`, newsletterScreenshot);
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

const checkProgress = async () => {
    // log("Checking for progress...");
    try {
        const progressPage = await axios.get(progressURL).then(r => r.data);
        const progressSha256 = sha256sum(progressPage);
        if (progressSha256 !== state.progress) {
            log(`NEW PROGRESS!`);
            const screenshotPath = await screenshot(progressURL, { progress: log, width: 720, height: 720, fullPage: true });
            const channel = await getChannel(config.channels.progress);
            const message = await channel.send({ content: `# [${config.firstrun ? "Current 7B progress:" : "New 7B progress!"}](${progressURL})\n-# ||<@&${config.roles.progress[0]}>||`, files: [screenshotPath] });
            message.crosspost().catch(() => { });
            post(`${config.firstrun ? "Current 7B progress:" : "New 7B progress!"} #deltarune\n${progressURL}`, screenshotPath);
            state.progress = progressSha256;
            changesMade = true;
        };
        session.checks.progress++;
    } catch (e) {
        log("Error checking progress", e);
        session.errors.progress++;
    };
};

const checkTwitter = async () => {
    for (const account in twitterAccounts) {
        // log(`Checking for ${twitterAccounts[account]} Twitter activity...`);
        try {
            const { tweets = [] } = (await twitter.users.replies(account)) || {};
            if (!state.twitter[account]) state.twitter[account] = [];
            for (let i = tweets.length - 1; i >= 0; i--) {
                const tweet = tweets[i];
                if (String(tweet.user?.id) === account && Date.now() - new Date(tweet.created_at).getTime() < config.maxage * 1000 && !state.twitter[account].includes(tweet.id)) {
                    log(`NEW TWEET BY ${twitterAccounts[account]}! https://x.com/i/status/${tweet.id}`);
                    const tweetScreenshot = await screenshot(`https://x.com/i/status/${tweet.id}`, { progress: log, element: 'article[data-testid="tweet"]', cookies: [{ name: 'auth_token', value: process.env.TWITTER_AUTH, domain: '.x.com', path: '/', httpOnly: true, secure: true, sameSite: 'None' }, { name: "night_mode", value: "2", domain: ".x.com", path: "/" }] });
                    const channel = await getChannel(config.channels.twitter);
                    const message = await channel.send({ content: `# ${config.firstrun ? "Last" : "New"} tweet by ${twitterAccounts[account]}:\n**<https://x.com/i/status/${tweet.id}>**\n-# ||<@&${config.roles.twitter[0]}>||`, files: [tweetScreenshot] });
                    message.crosspost().catch(() => { });
                    post(`${config.firstrun ? "Last" : "New"} tweet by ${twitterAccounts[account]}: #deltarune\nhttps://x.com/i/status/${tweet.id}`, tweetScreenshot, ["bluesky"]);
                    await twitter.tweets.retweet(tweet.id);
                    state.twitter[account].push(tweet.id);
                    changesMade = true;
                };
            };
        } catch (e) {
            log(`Error checking Twitter for ${twitterAccounts[account]}`, e);
            session.errors.twitter++;
        };
    };
    session.checks.twitter++;
};

const checkBluesky = async () => {
    for (const account in bskyAccounts) {
        // log(`Checking for ${bskyAccounts[account]} Bluesky activity...`);
        try {
            const authorFeed = await bsky.getAuthorFeed({ actor: account });
            const posts = authorFeed.data?.feed ?? [];
            if (!state.bsky[account]) state.bsky[account] = [];
            for (let i = posts.length - 1; i >= 0; i--) {
                const entry = posts[i];
                if (entry.post?.author?.did === account && Date.now() - new Date(entry.post?.indexedAt).getTime() < config.maxage * 1000 && !state.bsky[account].includes(entry.post?.uri)) {
                    const postURL = `https://bsky.app/profile/${entry.post?.author?.handle}/post/${entry.post?.uri.split('/').pop()}`;
                    log(`NEW BLUESKY POST BY ${bskyAccounts[account]}! ${postURL}`);
                    const postScreenshot = await screenshot(postURL, {
                        progress: log, element: `[data-testid="postThreadItem-by-${entry.post?.author?.handle}"]`, evalme: async page => {
                            await page.goto('https://bsky.app');
                            await page.evaluate((ACCOUNT) => localStorage.setItem('BSKY_STORAGE', JSON.stringify({ colorMode: "dark", darkTheme: "dark", session: { accounts: [ACCOUNT], currentAccount: ACCOUNT }, reminders: {}, languagePrefs: { primaryLanguage: "en", contentLanguages: ["en"], postLanguage: "en", postLanguageHistory: ["en"], appLanguage: "en" }, requireAltTextEnabled: false, largeAltBadgeEnabled: false, externalEmbeds: {}, mutedThreads: [], invites: { copiedInvites: [] }, onboarding: { step: "Home" }, hiddenPosts: [], pdsAddressHistory: [], disableHaptics: false, disableAutoplay: false, kawaii: false, hasCheckedForStarterPack: true, subtitlesEnabled: true, trendingDisabled: false, trendingVideoDisabled: false })), { service: "https://bsky.social/", signupQueued: false, pdsUrl: "https://fibercap.us-west.host.bsky.network/", isSelfHosted: false, ...bsky.session });
                        }
                    });
                    const channel = await getChannel(config.channels.bluesky);
                    const message = await channel.send({ content: `# ${config.firstrun ? "Last" : "New"} Bluesky post by ${bskyAccounts[account]}:\n**<${postURL}>**\n-# ||<@&${config.roles.bluesky[0]}>||`, files: [postScreenshot] });
                    message.crosspost().catch(() => { });
                    post(`${config.firstrun ? "Last" : "New"} Bluesky post by ${bskyAccounts[account]}: #deltarune\n${postURL}`, postScreenshot, ["twitter"]);
                    await bsky.repost(entry.post.uri, entry.post.cid);
                    state.bsky[account].push(entry.post?.uri);
                    changesMade = true;
                };
            };
        } catch (e) {
            log(`Error checking Bluesky for ${bskyAccounts[account]}`, e);
            session.errors.bluesky++;
        };
    };
    session.checks.bluesky++;
};

// initializer
const check = async () => {
    try {
        await checkNewsletters();
        await checkProgress();
        await checkTwitter();
        await checkBluesky();
        // log("All checks completed.");
    } catch (e) {
        log("Error in check loop", e);
        session.errors.others++;
    } finally {
        if (changesMade) saveState();
        setTimeout(check, config.interval * 1000);
        session.lastCheck = Date.now();
    };
};

const app = express();
app.use("/screenshots", express.static("screenshots"));
app.get("/state", (_, res) => res.json({ config, state, session }));
app.get("/logs", (_, res) => res.sendFile("logs.log"));
app.get("/errors", (_, res) => res.sendFile("errors.log"));
app.get("/screenshots", (_, res) => res.json(readdirSync("./screenshots/")));

(async () => {
    log("Hello World!");
    const PORT = process.env.PORT || 1111; // WHETHER 11 HOURS OR 11 YEARS, DELTARUNE WILL BE WAITING.
    app.listen(PORT, () => log(`Live on http://127.0.0.1:${PORT}/`));
    await client.login(process.env.DISCORD_TOKEN);
    await twitter.login(process.env.TWITTER_AUTH);
    await bsky.login({ identifier: process.env.BSKY_HANDLE, password: process.env.BSKY_PASSWORD });
    if (state.queue.length > 0 && !runningHandler) runningHandler = postHandler();
    check();
})();