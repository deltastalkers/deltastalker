import { EmbedBuilder, AttachmentBuilder } from "discord.js";
import { basename } from "node:path";
const message = ({ title, url, description, image, color }) => {
    const file = new AttachmentBuilder(image);
    const embed = new EmbedBuilder()
        .setTitle(title)
        .setColor(color)
        .setImage(`attachment://${basename(image)}`)
        .setTimestamp(Date.now())
        .setFooter({ text: "deltastalkers.github.io", iconURL: "https://deltastalkers.github.io/trickytony.png" });
    if (url) embed.setURL(url);
    if (description) embed.setDescription(description);
    return { embeds: [embed], files: [file] };
};
const post = (title, url, between) => `${title} #deltarune${between ? `\n${between}` : ""}\n${url}`;
export default {
    newsletter: ({ firstCheck, url, title, description, image }) => {
        const final = firstCheck ? "Last Toby Fox newsletter:" : "New Toby Fox newsletter!";
        return { socials: [post(final, url, `${title}\n${description}`), image], discord: message({ title: final, description: `# [${title}](${url})\n${description}`, image, color: 0xffff00 }) };
    },
    page: ({ firstCheck, url, name, image }) => {
        const final = `${name} ${firstCheck ? "currently:" : "updated!"}`;
        return { socials: [post(final, url), image], discord: message({ title: final, url, image, color: 0x00ffff }) };
    },
    twitterProfile: ({ name, firstProfileCheck, url, image }) => {
        const final = `${name}'s ${firstProfileCheck ? "current Twitter profile:" : "Twitter profile updated!"}`;
        return { socials: [post(final, url), image], discord: message({ title: final, url, image, color: 0x8000ff }) };
    },
    twitterPost: ({ firstTweetCheck, name, url, image }) => {
        const final = `${firstTweetCheck ? "Last" : "New"} tweet by ${name}${firstTweetCheck ? ":" : "!"}`;
        return { socials: [post(final, url), image], discord: message({ title: final, url, image, color: 0x0000ff }) };
    },
    bskyProfile: ({ name, firstProfileCheck, url, image }) => {
        const final = `${name}'s ${firstProfileCheck ? "current Bluesky profile:" : "Bluesky profile updated!"}`;
        return { socials: [post(final, url), image], discord: message({ title: final, url, image, color: 0x8000ff }) };
    },
    bskyPost: ({ firstPostCheck, name, url, image }) => {
        const final = `${firstPostCheck ? "Last" : "New"} Bluesky post by ${name}${firstPostCheck ? ":" : "!"}`;
        return { socials: [post(final, url), image], discord: message({ title: final, url, image, color: 0x0000ff }) };
    },
};