const $ = id => document.getElementById(id);
const logsDiv = $("logs");
const now = $("now");
const stateEl = $("state");
const sessionEl = $("session");
const addLog = (timestamp, data, error) => {
    const timestampText = `[${new Date(timestamp).toISOString()}]`;
    const dataText = `${data}${error ? `: ${error.message}, ${error.stack || "no stack trace available"}` : ""}`;

    const log = document.createElement("div");
    log.className = "log";
    log.addEventListener("click", () => navigator.clipboard.writeText(`${timestampText} ${dataText}`));

    const timestampEl = document.createElement("span");
    timestampEl.textContent = timestampText;
    timestampEl.className = "timestamp";

    const dataEl = document.createElement("span");
    dataEl.className = error ? "data error" : "data";
    dataEl.textContent = dataText;

    log.appendChild(timestampEl);
    log.appendChild(dataEl);
    logsDiv.appendChild(log);
    logsDiv.scrollTop = logsDiv.scrollHeight;
};
setInterval(() => now.textContent = `[${new Date().toISOString()}]`, 200);

const socket = io();
socket.on("LOGS", logs => {
    console.log("LOGS", logs);
    logsDiv.innerHTML = "";
    for (const log of logs) addLog(...log);
});
socket.on("LOG", log => {
    console.log("LOG", log);
    addLog(...log);
});
socket.on("STATE", state => {
    console.log("STATE", state);
    stateEl.textContent = JSON.stringify(state, null, 2);
});
socket.on("SESSION", session => {
    console.log("SESSION", session);
    sessionEl.textContent = JSON.stringify(session, null, 2);
});
// ngl got lazy with the last two but who careeeessssssss