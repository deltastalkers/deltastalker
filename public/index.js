const $ = s => document.querySelector(s);
const logsDiv = $("#logs");
const now = $("#now");
const stateEl = $("#state");
const sessionEl = $("#session");
const configEl = $("#config");
const displayCountEl = $("#display-count");
const categoriesDiv = $(".categories");
const categoriesList = $("#categories");
const filterBtn = $("#filter");
const clearBtn = $("#clear");
const bottomBtn = $("#bottom");
const closeFilterBtn = $("#close-filter");

let categories = {};

const styleEl = document.createElement("style");
document.head.appendChild(styleEl);

const updateLogs = () => {
    const updatedStyle = [];
    const categoryNames = Object.keys(categories);
    for (const category of categoryNames) {
        const label = document.querySelector(`#category-${category} label`);
        if (label) label.innerHTML = `${category} <span class="translucent">(${categories[category].count})</span>:`;
        if (!categories[category].display) updatedStyle.push(`.log[category="${category}"] { display: none; }`);
    };
    const displayingCategories = categoryNames.filter(c => categories[c].display);
    filterBtn.innerHTML = `filter${displayingCategories.length < categoryNames.length ? ` (${displayingCategories.length}/${categoryNames.length})` : ""}`;

    const displayingLogCount = displayingCategories.reduce((a, c) => a + categories[c].count, 0);
    displayCountEl.textContent = `Displaying ${displayingCategories.length === categoryNames.length ? "all " : ""}${displayingLogCount} log${displayingLogCount === 1 ? "" : "s"}`;
    styleEl.textContent = updatedStyle.join(' ');
};

filterBtn.addEventListener("click", () => {
    updateLogs();
    categoriesDiv.style.display = "flex";
});

closeFilterBtn.addEventListener("click", () => {
    categoriesDiv.style.display = "none";
});

categoriesDiv.addEventListener("click", (e) => {
    if (e.target === categoriesDiv) categoriesDiv.style.display = "none";
});

document.addEventListener("keydown", (e) => {
    if (e.key === "Escape") categoriesDiv.style.display = "none";
});

const addLog = ({ timestamp, data, category, error }) => {
    if (!Object.keys(categories).includes(category)) {
        categories[category] = { count: 0, display: true };

        const categoryDiv = document.createElement("div");
        categoryDiv.className = "category-row hoverable";
        categoryDiv.id = `category-${category}`;

        const label = document.createElement("label");
        label.innerHTML = `${category} <span class="translucent">(0)</span>:`;
        label.setAttribute("for", `checkbox-${category}`);

        const switchLabel = document.createElement("label");
        switchLabel.className = "switch";
        switchLabel.setAttribute("for", `checkbox-${category}`);

        const displayCheckbox = document.createElement("input");
        displayCheckbox.type = "checkbox";
        displayCheckbox.id = `checkbox-${category}`;
        displayCheckbox.checked = true;
        displayCheckbox.addEventListener("click", () => {
            categories[category].display = displayCheckbox.checked;
            updateLogs();
        });

        const slider = document.createElement("span");
        slider.className = "slider";

        switchLabel.appendChild(displayCheckbox);
        switchLabel.appendChild(slider);
        categoryDiv.appendChild(label);
        categoryDiv.appendChild(switchLabel);
        categoriesList.appendChild(categoryDiv);
    }
    categories[category].count++;

    const log = document.createElement("div");
    log.className = "log hoverable";
    log.setAttribute("category", category);

    const logDetails = document.createElement("span");
    logDetails.innerHTML = `<span class="timestamp">${timestamp}</span><span class="category">${category}</span>`;
    logDetails.className = "logDetails";

    const dataEl = document.createElement("span");
    dataEl.className = error ? "data error" : "data";
    dataEl.textContent = `${data}${error ? `: ${error.message}, ${error.stack || "no stack trace available"}` : ""}`;

    log.appendChild(logDetails);
    log.appendChild(dataEl);
    logsDiv.appendChild(log);

    if (logsDiv.scrollHeight - logsDiv.scrollTop - logsDiv.clientHeight < 128) logsDiv.scrollTop = logsDiv.scrollHeight;
};

setInterval(() => now.textContent = `${new Date().toISOString()}`, 200);
bottomBtn.addEventListener("click", () => logsDiv.scrollTop = logsDiv.scrollHeight);

const socket = io();
socket.on("LOGS", logs => {
    console.log("LOGS", logs);
    logsDiv.innerHTML = "";
    for (const cat of Object.keys(categories)) categories[cat].count = 0;
    for (const log of logs) addLog(log);
    updateLogs();
    logsDiv.scrollTop = logsDiv.scrollHeight;
});
socket.on("LOG", log => {
    console.log("LOG", log);
    addLog(log);
    updateLogs();
});
socket.on("STATE", state => {
    console.log("STATE", state);
    stateEl.textContent = JSON.stringify(state, null, 2);
    stateEl.removeAttribute("data-highlighted");
    hljs.highlightElement(stateEl);
});
socket.on("SESSION", session => {
    console.log("SESSION", session);
    sessionEl.textContent = JSON.stringify(session, null, 2);
    sessionEl.removeAttribute("data-highlighted");
    hljs.highlightElement(sessionEl);
});
socket.on("CONFIG", config => {
    console.log("CONFIG", config);
    configEl.textContent = JSON.stringify(config, null, 2);
    configEl.removeAttribute("data-highlighted");
    hljs.highlightElement(configEl);
});
clearBtn.addEventListener("click", async () => {
    if (!confirm("clear last logs?")) return;
    socket.emit("CLEAR_LOGS");
});