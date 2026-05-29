
// ================================
// ESPTimeCast Web Installer
// ================================

/* ============================================================
   SECTION 1-4: (UTILITIES, SLIP, PACKETS, MANIFEST) - UNCHANGED
   ============================================================ */
function isSupportedBrowser() {
    const isMobile = /Android|iPhone|iPad|iPod/i.test(navigator.userAgent);
    const hasSerial = "serial" in navigator;
    return hasSerial && !isMobile;
}
import { Transport, ESPLoader } from './esptools.js';

async function finalizeConnection({ port, transport, reader, writer }) {
    currentInstallContext = null;
    try {
        if (reader) {
            try { await reader.cancel(); } catch { }
            try { reader.releaseLock(); } catch { }
        }
        if (writer) {
            try { writer.releaseLock(); } catch { }
        }
        if (transport) {
            try { await transport.disconnect(); } catch { }
        }
        if (port) {
            try { await port.close(); } catch { }
            await new Promise(r => setTimeout(r, 50));
        }
        log("Connection finalized");
    } catch (e) {
        log("⚠️ Finalize error: " + e.message);
    }
}

let currentInstallContext = null;
const terminal = document.getElementById("terminal");
const log = (...a) => console.log("[INFO]", ...a);
const sleep = ms => new Promise(r => setTimeout(r, ms));
let authorizedPorts = [];

function slipEncode(data) {
    const res = [0xC0];
    for (const b of data) {
        if (b === 0xC0) res.push(0xDB, 0xDC);
        else if (b === 0xDB) res.push(0xDB, 0xDD);
        else res.push(b);
    }
    res.push(0xC0);
    return new Uint8Array(res);
}

async function detectESP32S2Port() {
    log("Requesting ESP32-S2 port again…");
    const ports = await navigator.serial.getPorts();
    for (const p of ports) {
        const info = p.getInfo();
        if (info.usbVendorId === 0x303a) {
            log("ESP32-S2 port found.");
            return p;
        }
    }
    // fallback: ask user to select port manually
    try {
        return await navigator.serial.requestPort();
    } catch (err) {
        if (err?.name === "NotFoundError") {
            log("ℹ️ Port selection canceled by user during S2 re-detect.");
            return null;
        }
        throw err;
    }
}

const SYNC_PACKET = slipEncode([0x00, 0x08, 0x24, 0x00, 0x00, 0x00, 0x00, 0x00, 0x07, 0x07, 0x12, 0x20, ...Array(32).fill(0x55)]);
const READ_REG_PACKET = slipEncode([0x00, 0x0a, 0x04, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x10, 0x00, 0x40]);

const manifest = {
    name: "ESPTimeCast",
    version: "1.6.0",
    builds: []
};

const basePath = `v${manifest.version}/`;

// ================================
// SUPABASE CONFIG
// ================================
const SUPABASE_URL = "https://doifjwehoimsazaqtsst.supabase.co";       
const SUPABASE_ANON_KEY = "sb_publishable_Mmd9Dy1i7tzVh67y6PSF9g_7INZeZnk";        

manifest.builds = [
    {
        chipFamily: "ESP8266",
        factory: basePath + "esp8266.bin",
        update: basePath + "esp8266.bin",
        boards: [
            { label: "Wemos D1 Mini", pins: { clk: 14, cs: 13, data: 15 } },
            { label: "ESP-12F", pins: { clk: 14, cs: 13, data: 12 } },
            { label: "Custom", pins: null }
        ]
    },
    {
        chipFamily: "ESP32",
        factory: basePath + "esp32_full.bin",
        update: basePath + "esp32_app.bin",
        boards: [
            { label: "Dev Module / D1 Mini ESP32", pins: { clk: 18, cs: 23, data: 5 } },
            { label: "Custom", pins: null }
        ]
    },
    {
        chipFamily: "ESP32-C3",
        factory: basePath + "esp32c3_full.bin",
        update: basePath + "esp32c3_app.bin",
        boards: [
            { label: "C3 SuperMini", pins: { clk: 4, cs: 10, data: 6 } },
            { label: "Custom", pins: null }
        ]
    },
    {
        chipFamily: "ESP32-S2",
        factory: basePath + "esp32s2_full.bin",
        update: basePath + "esp32s2_app.bin",
        boards: [
            { label: "S2 Mini", pins: { clk: 7, cs: 11, data: 12 } },
            { label: "Adafruit Feather", pins: { clk: 36, cs: 10, data: 35 } },
            { label: "Custom", pins: null }
        ]
    },
    {
        chipFamily: "ESP32-S3",
        factory: basePath + "esp32s3_full.bin",
        update: basePath + "esp32s3_app.bin",
        boards: [
            { label: "S3 WROOM-1", pins: { clk: 18, cs: 16, data: 17 } },
            { label: "S3-Zero", pins: { clk: 12, cs: 11, data: 10 } },
            { label: "S3 SuperMini", pins: { clk: 4, cs: 5, data: 6 } },
            { label: "Custom", pins: null }
        ]
    }
];


if (navigator.serial) {
    navigator.serial.addEventListener("disconnect", (event) => {
        const port = event.target;
        log("⚠️ Serial device disconnected");
        // If this was the active install port → show boot mode screen
        if (currentInstallContext) {
            slideDisconnected();
        }
    });
}

function uint8ToBinaryString(uint8) {
    let result = "";
    const chunkSize = 0x8000; // prevents stack overflow

    for (let i = 0; i < uint8.length; i += chunkSize) {
        result += String.fromCharCode(...uint8.subarray(i, i + chunkSize));
    }

    return result;
}

/* ============================================================
   SECTION 5: INSTALL CONFIRMATION UI
   ============================================================ */
async function flashFirmwareWithRetry(port, chip, firmwarePath, pinoutData = null, maxRetries = 3) {
    let currentPort = port;
    slideFlashing();
    for (let attempt = 1; attempt <= maxRetries; attempt++) {
        const startTime = Date.now(); // Record start time

        try {
            log(`Flash attempt ${attempt} of ${maxRetries}...`);
            await flashFirmware(currentPort, chip, firmwarePath, pinoutData);
            log("✅ Flash succeeded!");
            return;
        } catch (err) {
            const duration = Date.now() - startTime;
            const errMsg = err.message || "";

            log(`Attempt ${attempt} failed after ${Math.round(duration / 1000)}s: ${errMsg}`);

            // DETECTION LOGIC:
            // If it's an S2 and it took a long time to fail (> 10 seconds), 
            // it's almost certainly because it's not in Bootloader Mode.
            if (chip === "ESP32-S2" && duration > 15000) {
                log("❌ S2 Bootloader Timeout: Device was detected but didn't respond.");
                log("👉 Ensure you hold the BOOT button while plugging in!");
                slideBootmode(); // Show the 'Please use Boot Button' error
                return; // Stop retrying immediately
            }

            // If it's a "fast" failure on attempt 1, try one quick re-detect
            if (attempt === 1 && chip === "ESP32-S2") {
                log("⚠️ Fast failure. Cleaning up port for re-sync...");
                await finalizeConnection({ port: currentPort });
                //await safeClosePort(currentPort); // Just close it, don't forget it
                await sleep(1000);
                currentPort = await detectESP32S2Port(); // This will find the existing authorized port without a popup
                if (!currentPort) return;
            } else {
                // Hard fail for everything else
                slideError();
                return;
            }
        }
    }
}

async function showInstallPrompt(port, chip, build, version) {
    document.getElementById("confirm-chip").innerHTML =
        `<strong>${chip}</strong> chip detected`;

    currentInstallContext = { build, version };
    updateConfirmText(false);

    // Board selector for ESP32 family
    const boardSelectorEl = document.getElementById("board-selector");
    if (build.boards && boardSelectorEl) {
        const selectEl = document.getElementById("board-select");
        selectEl.innerHTML = build.boards.map((b, i) =>
            `<option value="${i}">${b.label}</option>`
        ).join("");
        updateBoardSelector();

        // Show/hide custom pins on change
        selectEl.addEventListener("change", (e) => {
            const selected = build.boards[e.target.value];
            const customDiv = document.getElementById("custom-pins");
            if (customDiv) customDiv.style.display = selected.pins === null ? "flex" : "none";
        });

        boardSelectorEl.style.display = "flex";
    } else if (boardSelectorEl) {
        boardSelectorEl.style.display = "none";
    }

    goToSlide("confirm");
    showHint(1);

    document.getElementById("confirm-cancel").onclick = () => {
        log("User cancelled installation");
        goToSlide("hero");
        resetHints();
    };

    document.getElementById("confirm-install").onclick = async () => {
        hideHints();
        const keepData = shouldKeepData();
        const selectedFirmware = keepData ? build.update : build.factory;

        let pinoutData = null;

        if (!keepData && build.boards) {
            const selectEl = document.getElementById("board-select");
            const selected = build.boards[selectEl?.value ?? 0];
            let pins;

            if (selected.pins === null) {
                const clk = parseInt(document.getElementById("pin-clk").value);
                const cs = parseInt(document.getElementById("pin-cs").value);
                const data = parseInt(document.getElementById("pin-data").value);

                if ([clk, cs, data].some(v => isNaN(v))) { log(`❌ Invalid pins`); return; }
                if (new Set([clk, cs, data]).size !== 3) { log("❌ Pins must all be different"); return; }
                pins = { clk, cs, data };
            } else {
                pins = selected.pins;
            }

            if (chip === "ESP8266") {
                pinoutData = generateEEPROMPayload({ magic: 0xAB, ...pins });
            } else {
                pinoutData = generateNVSPartition("pins", pins);
            }
        }

        await flashFirmwareWithRetry(port, chip, "bins/" + selectedFirmware, pinoutData, 3);
    };
}

/* ============================================================
   SECTION 6: MAIN DETECTION FLOW
   ============================================================ */
document.getElementById("start").onclick = async () => {

    hideHints();

    try {
        await runFlasher();
    } catch (e) {
        log("❌ Fatal error: " + e.message);
        slideError();
    }
};

function reportDetectedChip(chip) {
    log("--------------------------");
    log(`RESULT: ${chip}`);
    log("--------------------------");
}

async function runFlasher() {

    let port, writer, reader;
    let result = "Unknown ESP";

    try {
        log("Requesting port…");

        try {
            port = await navigator.serial.requestPort();
        } catch (err) {
            if (err?.name === "NotFoundError") {
                log("ℹ️ Port selection canceled by user.");
                resetHints();
                return; // ← abort runFlasher quietly
            }
            throw err; // real error, propagate
        }

        goToSlide("detecting");
        await nextFrame();
        const initStart = Date.now();
        const ensureMinDetectTime = async () => {
            const initElapsed = Date.now() - initStart;
            if (initElapsed < 2000) {
                await sleep(2000 - initElapsed);
            }
        };
        authorizedPorts = await navigator.serial.getPorts();
        const info = port.getInfo();

        // First try USB PID detection
        let chipByPID = null;
        if (info.usbVendorId === 0x303a) { // Espressif native USB
            if ([0x1001, 0x1002, 0x1003].includes(info.usbProductId)) {
                // This ID is shared by S3 and C3. 
                // We mark it as a "Native" hint but don't assign a final name yet.
                chipByPID = "NATIVE_CDC";
            } else if ([0x0002, 0x0003].includes(info.usbProductId)) {
                chipByPID = "ESP32-S2";
            }
        }

        if (chipByPID === "ESP32-S2") {
            log("ESP32-S2 detected via native USB.");
            log("Skipping ROM probe (native USB reliability mode).");

            reportDetectedChip("ESP32-S2");

            const build = manifest.builds.find(b => b.chipFamily === "ESP32-S2");
            if (!build) throw new Error("ESP32-S2 build not found");

            // Go straight to the prompt.
            // If Attempt 1 fails due to hardware noise, Attempt 2 will catch it.
            await ensureMinDetectTime();
            await showInstallPrompt(port, "ESP32-S2", build, manifest.version);

            return; // S2 fully handled
        }
        if (chipByPID === "NATIVE_CDC") {
            log("Native USB CDC device detected (ESP32-C3 or ESP32-S3).");
            log("Using USB reset mode — no boot button needed.");

            // Don't do manual UART probe — let ESPLoader handle it
            await ensureMinDetectTime();

            // Use ESPLoader to connect and identify the chip
            let detectedChip = null;
            const transport = new Transport(port, false);
            try {
                const loader = new ESPLoader({
                    transport,
                    baudrate: 460800,
                    terminal: {
                        clean: () => { },
                        writeLine: (msg) => log(msg),
                        write: (msg) => log(msg),
                    }
                });

                await loader.main("usb_reset");  // ← triggers bootloader via CDC, no button needed
                detectedChip = loader.chip.CHIP_NAME; // "ESP32-S3" or "ESP32-C3"
                log(`Identified via USB reset: ${detectedChip}`);

                // Disconnect cleanly so flashFirmware can reconnect
                await finalizeConnection({ port, transport });

            } catch (e) {
                log(`⚠️ USB reset identify failed: ${e.message}`);
                await finalizeConnection({ port, transport });
                slideError();
                return;
            }

            // Map chip name to result
            if (detectedChip?.includes("S3")) result = "ESP32-S3";
            else if (detectedChip?.includes("C3")) result = "ESP32-C3";
            else {
                slideUnknownESP();
                return;
            }

            reportDetectedChip(result);

            const build = manifest.builds.find(b => b.chipFamily === result);
            if (!build) { slideUnsupportedBoard(result); return; }

            await showInstallPrompt(port, result, build, manifest.version);
            return;
        }

        // --- only open port for non-S2 chips ---
        await port.open({ baudRate: 115200 });
        writer = port.writable.getWriter();
        reader = port.readable.getReader();

        log("Sending Sync...");
        let synced = false;
        for (let i = 0; i < 20; i++) {
            await writer.write(SYNC_PACKET);
            let { value } = await Promise.race([reader.read(), sleep(100).then(() => ({ value: null }))]);
            if (value && [...value].map(b => b.toString(16)).join("").includes("18")) {
                synced = true;
                break;
            }
            if (i === 10) {
                log("No response. Trying DTR/RTS Reset...");
                await port.setSignals({ dataTerminalReady: false, requestToSend: true });
                await sleep(100);
                await port.setSignals({ dataTerminalReady: true, requestToSend: false });
                await sleep(100);
                await port.setSignals({ dataTerminalReady: false, requestToSend: false });
            }
        }

        if (!synced) throw new Error("Sync Failed");

        log("SYNC OK. Waiting for silence...");
        await sleep(200);

        // Magic number detection
        let magic = null;
        log("Requesting Chip ID...");
        for (let attempt = 0; attempt < 5; attempt++) {
            await writer.write(READ_REG_PACKET);
            let responseHex = "";
            for (let i = 0; i < 10; i++) {
                const { value } = await Promise.race([reader.read(), sleep(60).then(() => ({ value: null }))]);
                if (value) responseHex += [...value].map(b => b.toString(16).padStart(2, "0")).join("");
            }
            const m = responseHex.match(/010a0[24]00([0-9a-f]{4,8})/);
            if (m) {
                const raw = m[1];
                magic = parseInt(raw.match(/.{2}/g).reverse().join(""), 16);
                //magic = 0xF45645646;
                log("Magic: 0x" + magic.toString(16).toUpperCase());
                break;
            }
            await sleep(100);
        }

        // Determine result either by PID or magic
        if (chipByPID === "ESP32-C3") result = "ESP32-C3";
        else if (magic === 0xFFF0C101 || magic === 0xC101) result = "ESP8266";
        else if (magic === 0x00F01D83) result = "ESP32";
        else if ([0x00000009, 0x00000000, 0x9].includes(magic)) result = "ESP32-S3";
        else if ([0x6921506F, 0x1B31506F, 0x4881606F, 0x09].includes(magic)) result = "ESP32-C3";
        else if ([0x000007C6, 0x00004359, 0x4359, 0x07C6].includes(magic)) result = "ESP32-S2";
        else if ([0x2CE0806F, 0x2CE0106F].includes(magic)) result = "ESP32-C6";
        else if (magic === 0xD422F199) result = "ESP32-H2";
        else if (magic === 0x1101406F) result = "ESP32-C2";

        log("Raw value: 0x" + (magic ? magic.toString(16).toUpperCase() : "null"));

        log("--------------------------");
        log("RESULT: " + result);
        log("--------------------------");

        // Cleanup locks
        await finalizeConnection({ port, reader, writer });
        writer = null;
        reader = null;

        // Case A: Unknown ESP
        if (result === "Unknown ESP") {
            await ensureMinDetectTime();
            slideUnknownESP();
            return;
        }

        // Case B: Known ESP, but unsupported
        const build = manifest.builds.find(b => b.chipFamily === result);
        if (!build) {
            await ensureMinDetectTime();
            slideUnsupportedBoard(result);
            return;
        }

        // Case C: Supported ESP
        await ensureMinDetectTime();
        await showInstallPrompt(port, result, build, manifest.version);

    } catch (e) {
        log("❌ Error: " + e.message);

        // ESP32-S2 native USB disconnect / running firmware case
        if (
            e.message?.includes("The device has been lost") ||
            e.message?.includes("not available") ||
            e.name === "NetworkError"
        ) {
            slideBootmode();
            return;
        }

        // Anything else is a real flash failure
        slideError();
    } finally {
        try { writer?.releaseLock(); } catch { }
        try { reader?.releaseLock(); } catch { }
    }
}
/* ============================================================
   SECTION 7: FLASHING
   ============================================================ */
function handleFlashStageMessage(msg) {
    const lower = msg.toLowerCase();
    if (lower.includes("erase") || lower.includes("erasing")) {
        setFlashingTitle("Erasing flash…");
    }
    else if (lower.includes("writing")) {
        setFlashingTitle("Writing firmware…");
    }
}

async function flashFirmware(port, chip, firmwarePath, pinoutData = null) {
    log("Starting flash using esptool-js...");
    const initStart = Date.now();
    if (chip === "ESP32-S2") {
        log("ESP32-S2: native USB handling enabled");
    }
    let transport = null;
    try {
        let nvsBinary = null;
        // Create transport with S2-specific settings
        const isNativeUSB = chip === "ESP32-S2" ||
            (chip === "ESP32-S3" && port.getInfo().usbVendorId === 0x303a) ||
            (chip === "ESP32-C3" && port.getInfo().usbVendorId === 0x303a);
        transport = new Transport(port, !isNativeUSB); // Invert: false = skip auto-open for native USB
        let baudrate = 460800;
        let connectMode = "default_reset";
        if (chip === "ESP32-S2") {
            baudrate = 115200; connectMode = "no_reset";
        } else if (chip === "ESP32") {
            baudrate = 460800; connectMode = "no_reset";
        } else if (chip === "ESP32-C3" && isNativeUSB) {
            connectMode = "usb_reset"; baudrate = 460800;
        } else if (chip === "ESP32-S3" && isNativeUSB) {
            connectMode = "usb_reset"; baudrate = 460800;
        }
        const loader = new ESPLoader({
            transport,
            baudrate,
            noReset: chip === "ESP32-S2",
            usbReset: (chip === "ESP32-S3" || chip === "ESP32-C3") && isNativeUSB,
            terminal: {
                clean: () => { },
                writeLine: (msg) => {
                    log(msg);
                    handleFlashStageMessage(msg); // keep this
                },
                write: (msg) => {
                    log(msg);
                }
            }
        });
        log(`Connecting to ${chip}...`);
        await loader.main(connectMode);
        log(`Connected. Chip: ${loader.chip.CHIP_NAME}`);
        log("Fetching firmware...");
        const response = await fetch(firmwarePath);
        if (!response.ok) throw new Error(`Failed to fetch firmware: ${response.statusText}`);
        const contents = await response.arrayBuffer();
        log(`Firmware loaded: ${contents.byteLength} bytes`);
        // Ensure Initializing is visible at least 1.5s
        const initElapsed = Date.now() - initStart;
        if (initElapsed < 2000) {
            await sleep(2000 - initElapsed);
        }
        log("Uploading firmware...");
        //setFlashingTitle("Flashing firmware...");
        switchToProgressRing();
        const uint8 = new Uint8Array(contents);
        const binaryData = new Uint8Array(contents);
        const keepData = shouldKeepData();
        const flashAddress = (keepData && chip.startsWith("ESP32")) ? 0x10000 : 0x0000;
        log("==================================================");
        log("INSTALL SESSION");
        log(`Chip: ${chip}`);
        log(`Mode: ${keepData ? "Update (Keep Data)" : "Factory (Erase All)"}`);
        log(`Firmware File: ${firmwarePath.split('/').pop()}`);
        log(`Full Path: ${firmwarePath}`);
        log(`Flash Address: 0x${flashAddress.toString(16).toUpperCase()}`);
        log(`Erase All Before Flash: ${!keepData}`);
        log("==================================================");

        // Prepare file array — firmware first, NVS second (NVS wins over merged bin)
        const fileArray = [];

        fileArray.push({
            data: uint8ToBinaryString(binaryData),
            address: flashAddress,
            size: binaryData.length
        });
        log(`Queued Firmware @ 0x${flashAddress.toString(16).toUpperCase()}`);

        if (pinoutData) {
            const writeAddress = chip === "ESP8266" ? 0x3FB000 : 0x9000; // 0x3FB000 = sector 1019 * 0x1000

            fileArray.push({
                data: uint8ToBinaryString(pinoutData),
                address: writeAddress,
                size: pinoutData.length
            });
            log(`Queued ${chip === "ESP8266" ? "EEPROM" : "NVS"} @ 0x${writeAddress.toString(16).toUpperCase()}`);
        }

        log(`FLASHING: ${!keepData ? "Full Erase + Write" : "Update Mode (preserve data)"}`);

        await loader.writeFlash({
            fileArray,
            flashSize: "keep",
            eraseAll: !keepData,
            compress: true,
            reportProgress: (fileIndex, written, total) => {
                let overallProgress = 0;

                for (let i = 0; i < fileArray.length; i++) {
                    if (i < fileIndex) {
                        // fully completed files
                        overallProgress += fileArray[i].size;
                    } else if (i === fileIndex) {
                        // current file progress (normalized)
                        const fraction = written / total;
                        overallProgress += fileArray[i].size * fraction;
                    }
                }

                const overallTotal = fileArray.reduce((sum, f) => sum + f.size, 0);

                const percent = Math.floor((overallProgress / overallTotal) * 100);

                updateProgressRing(Math.min(percent, 99)); // prevent early 100%
            }
        });

        // Flash finished
        const finalizeStart = Date.now();
        setFlashingTitle("Finalizing...");
        updateProgressRing(100);
        // Ensure Finalizing is visible at least 1.5s
        const finalizeElapsed = Date.now() - finalizeStart;
        if (finalizeElapsed < 2000) {
            await sleep(2000 - finalizeElapsed);
        }
        log("Flash complete. Rebooting device...");
        try {
            if (chip === "ESP8266" || chip === "ESP32" || (chip === "ESP32-S3" && port.getInfo().usbVendorId !== 0x303a)) {
                log(`Will perform UART reset for ${chip}...`);
                await transport.setDTR(false);
                await sleep(100);
                await transport.setDTR(true);
                log(`✅ ${chip} UART reset complete.`);
                installSuccess(true, chip, keepData);
            } else {
                log(`UART reset not available on this board: ${chip}`);
                installSuccess(false, chip, keepData);
            }
        } catch (e) {
            log("⚠️ Reboot handling failed: " + e.message);
            installSuccess(false, chip, keepData);
        }
        log("Installation complete! Device should now reboot.");
    } catch (err) {
        log("❌ Flash Error: " + err.message);
        console.error(err);
        throw err;
    } finally {
        try {
            await finalizeConnection({ port, transport });
        } catch (cleanupError) {
            log("Cleanup error: " + cleanupError.message);
        }
    }
}


// ================================
// PROGRESS INDICATOR
// ================================
function parseFlashProgress(msg) {
    const match = msg.match(/\((\d+)%\)/);
    if (!match) return null;
    return parseInt(match[1], 10);
}

let progressRingBar = null;
let progressText = null;
let progressWrapper = null;
let progressCircumference = 0;

function ensureProgressRing() {
    const status = document.getElementById("flashing-status");
    if (!status) return null;

    if (progressRingBar && progressWrapper && status.contains(progressWrapper)) {
        return progressRingBar;
    }

    const wrapper = document.createElement("div");
    wrapper.className = "progress-ring-wrapper hidden";

    wrapper.innerHTML = `
        <svg width="56" height="56" viewBox="0 0 48 48">
            <circle class="progress-ring-track" cx="24" cy="24" r="20"></circle>
            <circle class="progress-ring-bar" cx="24" cy="24" r="20"></circle>
        </svg>
        <div class="progress-text">0%</div>
    `;

    status.appendChild(wrapper);

    progressWrapper = wrapper;
    progressRingBar = wrapper.querySelector(".progress-ring-bar");
    progressText = wrapper.querySelector(".progress-text");

    const radius = progressRingBar.r.baseVal.value;
    progressCircumference = 2 * Math.PI * radius;

    progressRingBar.style.strokeDasharray = progressCircumference;
    progressRingBar.style.strokeDashoffset = progressCircumference;

    return progressRingBar;
}

function showProgressRing() {
    ensureProgressRing();
    if (!progressWrapper) return;

    progressWrapper.classList.remove("hidden");
    requestAnimationFrame(() => {
        progressWrapper.classList.add("visible");
    });

    visualProgress = 0;
    targetProgress = 0;

    progressRingBar.style.strokeDashoffset = progressCircumference;
    progressText.textContent = "0%";
}

function updateProgressRing(percent) {
    if (!progressRingBar) return;
    targetProgress = Math.max(0, Math.min(100, percent));
    if (!progressAnimationFrame) {
        const step = () => {
            const diff = targetProgress - visualProgress;
            if (Math.abs(diff) < 0.1) {
                visualProgress = targetProgress;
            } else {
                visualProgress += diff * 0.15; // smooth easing
            }
            const offset =
                progressCircumference -
                (visualProgress / 100) * progressCircumference;
            progressRingBar.style.strokeDashoffset = offset;
            progressText.textContent = `${Math.round(visualProgress)}%`;
            if (visualProgress !== targetProgress) {
                progressAnimationFrame = requestAnimationFrame(step);
            } else {
                progressAnimationFrame = null;
            }
        };
        progressAnimationFrame = requestAnimationFrame(step);
    }
}

let visualProgress = 0;
let targetProgress = 0;
let progressAnimationFrame = null;


// ================================
// INSTALL TRACKING
// ================================
async function trackInstall(chip, isUpdate) {
    try {
        await fetch(`${SUPABASE_URL}/functions/v1/track-install`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
                chip: chip,
                type: isUpdate ? "update" : "install",
                version: manifest.version
            })
        });
        log(`📊 Tracked: ${isUpdate ? "update" : "install"} on ${chip}`);
    } catch (e) {
        log("⚠️ Tracking failed (non-critical): " + e.message);
    }
}

async function fetchInstallCount() {
    try {
        const [countRes, seedRes] = await Promise.all([
            fetch(`${SUPABASE_URL}/rest/v1/installs?select=id`, {
                headers: {
                    "apikey": SUPABASE_ANON_KEY,
                    "Authorization": `Bearer ${SUPABASE_ANON_KEY}`,
                    "Prefer": "count=exact",
                    "Range": "0-0"
                }
            }),
            fetch(`${SUPABASE_URL}/rest/v1/config?key=eq.install_seed&select=value`, {
                headers: {
                    "apikey": SUPABASE_ANON_KEY,
                    "Authorization": `Bearer ${SUPABASE_ANON_KEY}`
                }
            })
        ]);

        const contentRange = countRes.headers.get("Content-Range");
        const realCount = contentRange ? parseInt(contentRange.split("/")[1]) || 0 : 0;

        const seedData = await seedRes.json();
        const seed = seedData?.[0]?.value ?? 2000;

        const total = seed + realCount;
        const el = document.getElementById("install-count");
        if (el) el.textContent = total.toLocaleString();
    } catch (e) {
        log("⚠️ Count fetch failed (non-critical): " + e.message);
    }
}

// ================================
// SCREENS
// ================================
async function slideFlashing() {
    goToSlide("flashing");
    resetFlashingUI();
}

function installSuccess(isUart = true, chip = "", keepData = false) {
    trackInstall(chip, keepData);
    currentInstallContext = null;

    const message = isUart
        ? "<b>ESPTimeCast</b> is now running on your device.<br> Connect to its Wi-Fi network to complete setup."
        : "Press <b>RESET</b> or reconnect your device.<br><b>ESPTimeCast</b> will start automatically.";

    document.getElementById("success-message").innerHTML = message;

    document.getElementById("success-message").innerHTML = message;

    goToSlide("success");

    const checkmark = document.querySelector(".checkmark");
    const body = document.body;
    const footerIcons = document.querySelector(".footer-icons");

    // --- RESET ---
    checkmark.classList.remove("animate");
    body.classList.remove("success-pulse");
    footerIcons?.classList.remove("animate");

    void checkmark.offsetWidth; // force reflow so animation can replay

    // --- Trigger Start checkmark ---
    checkmark.classList.add("animate");

    // --- Trigger pulse mid-animation ---
    setTimeout(() => {
        body.classList.add("success-pulse");
    }, 400);

    // --- Trigger icons stagger ---
    setTimeout(() => {
        footerIcons?.classList.add("animate");
    }, 1100);

    document.getElementById("flash-another").onclick = () => {
        resetSuccessAnimations();
        goToSlide("hero");
        resetHints();
    };
}

function slideBootmode() {
    goToSlide("boot-mode");
    document.getElementById("boot-mode-close").onclick = () => {
        log("User cancelled installation");
        goToSlide("hero");
        resetHints();
    };
}

function slideError() {
    goToSlide("error");
    document.getElementById("error-close").onclick = () => {
        log("User cancelled installation");
        goToSlide("hero");
        resetHints();
    };
}

function slideDisconnected() {
    goToSlide("disconnected");
    document.getElementById("disconnect-close").onclick = () => {
        log("User cancelled installation");
        goToSlide("hero");
        resetHints();
    };
}

function slideUnsupportedBoard(chip) {
    // Fill static text (ONE TIME, safe)
    document.getElementById("confirm-chip-unsupported").innerHTML =
        `Unsupported <strong>${chip}</strong> board detected`;

    // Move to confirm slide
    goToSlide("unsupported");

    // Wire buttons
    document.getElementById("unsupported-cancel").onclick = () => {
        log("User cancelled installation");
        goToSlide("hero");
        resetHints();
    };

    document.getElementById("unsupported-github").onclick = () => {
        window.open(
            "https://github.com/mfactory-osaka/ESPTimeCast",
            "_blank"
        );
    };
}

function slideUnknownESP() {
    goToSlide("unknown");
    document.getElementById("unknown-close").onclick = () => {
        log("User cancelled installation");
        goToSlide("hero");
        resetHints();
    };
}

function nextFrame() {
    return new Promise(resolve => requestAnimationFrame(resolve));
}

let currentSlide = document.querySelector(".slide.active");

async function goToSlide(name) {
    const next = document.querySelector(`[data-slide="${name}"]`);
    if (!next || next === currentSlide) return;
    const oldSlide = currentSlide;

    // 1. Start the exit animation for the current slide
    if (oldSlide) {
        oldSlide.classList.remove("active");
        oldSlide.classList.add("exit-left");

        // 2. Cleanup: After the 0.5s transition, reset its position to the right
        // so it's ready for the next time it's called.
        setTimeout(() => {
            oldSlide.classList.remove("exit-left");
            // By removing exit-left, the base .slide CSS puts it back at translateX(80px)
        }, 500);
    }

    // 3. Prepare the next slide to enter from the right
    next.classList.remove("exit-left"); // Safety
    next.classList.add("pre-right");
    void next.offsetWidth; // Force reflow to "snap" it to the right position

    // 4. Trigger the entry
    next.classList.remove("pre-right");
    next.classList.add("active");
    updateStepper(name);
    currentSlide = next;
}

function updateStepper(slideName) {
    let currentStep = 1;
    if (slideName === "confirm") {
        currentStep = 2;
    }
    if (slideName === "flashing") {
        currentStep = 2; // still in confirmation phase
    }
    if (slideName === "success") {
        currentStep = 3;
    }
    document.querySelectorAll(".step").forEach(step => {
        const stepNumber = parseInt(step.dataset.step, 10);
        step.classList.remove("active", "done");
        if (stepNumber < currentStep) {
            step.classList.add("done");
        } else if (stepNumber === currentStep) {
            step.classList.add("active");
        }
    });
}

function showHint(index) {
    const hints = document.querySelectorAll(".hints .hint");
    hints.forEach((hint, i) => {
        hint.classList.remove("active");
    });
    if (hints[index]) {
        hints[index].classList.add("active");
    }
}

function resetHints() {
    const hints = document.querySelectorAll(".hints .hint");
    // Remove active from all
    hints.forEach(hint => hint.classList.remove("active"));
    // Small delay allows fade-out animation
    setTimeout(() => {
        hints[0].classList.add("active");
    }, 200);
}

function hideHints() {
    const hints = document.querySelectorAll(".hints .hint");
    hints.forEach(hint => hint.classList.remove("active"));
}

function setFlashingTitle(text) {
    const title = document.getElementById("flashing-title");
    if (title) title.textContent = text;
}

function showLoader() {
    const loader = document.getElementById("flash-loader");
    if (loader) loader.style.display = "inline-block";

    if (progressAnimationFrame) {
        cancelAnimationFrame(progressAnimationFrame);
        progressAnimationFrame = null;
    }

    if (progressWrapper) progressWrapper.remove();

    progressWrapper = null;
    progressRingBar = null;
    progressText = null;
}

function switchToProgressRing() {
    const loader = document.getElementById("flash-loader");
    if (loader) loader.style.display = "none";

    showProgressRing();
}

function resetFlashingUI() {
    setFlashingTitle("Preparing...");
    showLoader();

    // Hard reset animation state
    visualProgress = 0;
    targetProgress = 0;

    if (progressAnimationFrame) {
        cancelAnimationFrame(progressAnimationFrame);
        progressAnimationFrame = null;
    }

    if (progressRingBar) {
        progressRingBar.style.strokeDashoffset = progressCircumference;
    }

    if (progressText) {
        progressText.textContent = "0%";
    }

    if (progressWrapper) {
        progressWrapper.classList.remove("visible");
    }
}

function resetSuccessAnimations() {
    const checkmark = document.querySelector(".checkmark");
    const footerIcons = document.querySelector(".footer-icons");

    document.body.classList.remove("success-pulse");
    footerIcons?.classList.remove("animate");

    if (checkmark) {
        checkmark.classList.remove("animate");
        // Force reflow so CSS animation can replay
        void checkmark.offsetWidth;
    }
}

let subtitleTimeout = null;
let hoverCount = 0;

function initFooterSubtitles() {
    const icons = document.querySelectorAll(".icon-btn");
    const subtitle = document.getElementById("footerSubtitle");

    if (!icons.length || !subtitle) return;

    const year = new Date().getFullYear();
    const version = manifest?.version ? ` v${manifest.version}` : "";
    const defaultText = `© ${year} ESPTimeCast${version}`;

    subtitle.textContent = defaultText;
    subtitle.classList.add("visible", "default-text");

    icons.forEach(icon => {
        icon.addEventListener("mouseenter", () => {
            hoverCount++;
            clearTimeout(subtitleTimeout);
            const newText = icon.getAttribute("aria-label");
            if (subtitle.textContent !== newText) {
                subtitle.classList.remove("visible");
                setTimeout(() => {
                    subtitle.textContent = newText;
                    subtitle.classList.remove("default-text");
                    subtitle.classList.add("visible");
                }, 100);
            }
        });

        icon.addEventListener("mouseleave", () => {
            hoverCount--;
            subtitleTimeout = setTimeout(() => {
                if (hoverCount === 0) {
                    subtitle.classList.remove("visible");
                    setTimeout(() => {
                        subtitle.textContent = defaultText;
                        subtitle.classList.add("default-text");
                        subtitle.classList.add("visible");
                    }, 120);
                }
            }, 250);
        });
    });
}

function enableUnsupportedMode() {
    const heroSlide = document.querySelector('[data-slide="hero"]');
    const startBtn = document.getElementById("start");
    const textLink = document.querySelector(".text-link");
    const stepper = document.querySelector(".stepper");
    const hints = document.querySelector(".hints");

    // Remove Start button
    if (startBtn) startBtn.remove();
    if (textLink) textLink.remove();

    // Prevent duplicate manual button
    if (!heroSlide.querySelector(".manual-btn")) {
        const manualBtn = document.createElement("a");
        manualBtn.href = "#manual";
        manualBtn.rel = "noopener noreferrer";
        manualBtn.className = "manual-btn";
        manualBtn.textContent = "Manual Installation Guide ↓";
        manualBtn.style.marginTop = '0';

        heroSlide.appendChild(manualBtn);
    }

    // Replace stepper content with warning
    if (stepper && !stepper.querySelector(".unsupported")) {
        stepper.innerHTML = `
          <div class="step unsupported">
            ⚠️ Desktop Chrome, Edge or Brave required
          </div>
        `;
    }

    // Hide hints
    if (hints) hints.style.display = "none";
}

document.addEventListener("DOMContentLoaded", () => {
    updateStepper("hero");
    initFooterSubtitles();
    if (!isSupportedBrowser()) {
        enableUnsupportedMode();
    }
});

// --- Helper function for flashing logic ---
function shouldKeepData() {
    // Returns true if the user wants to preserve current data
    return localStorage.getItem('keepData') === 'true';
}

function updateConfirmText(animate = true) {
    if (!currentInstallContext) return;

    const { version } = currentInstallContext;
    const versionEl = document.getElementById("confirm-version");
    if (!versionEl) return;

    const keepData = shouldKeepData();

    const newHTML = keepData
        ? `Updating to <strong>v${version}</strong> - your settings will be preserved.`
        : `Installing <strong>v${version}</strong> will erase all your settings and data.`;

    if (!animate) {
        // Instant update (no fade)
        versionEl.innerHTML = newHTML;
        return;
    }

    // Fade mode
    versionEl.classList.add("fading");

    setTimeout(() => {
        versionEl.innerHTML = newHTML;
        versionEl.classList.remove("fading");
    }, 200);
}

document.addEventListener("DOMContentLoaded", () => {

    updateStepper("hero");
    initFooterSubtitles();

    if (!isSupportedBrowser()) {
        enableUnsupportedMode();
    }

    const cogIcon = document.querySelector('.icon-cog');
    const modal = document.getElementById('settings-modal');
    const eraseAllCheckbox = document.getElementById('erase-all-data');
    const closeBtn = document.getElementById("close-settings");

    if (!cogIcon || !modal || !eraseAllCheckbox) return;

    // Load saved setting
    eraseAllCheckbox.checked =
        localStorage.getItem('keepData') !== 'true';
    updateBoardSelector();

    // Open modal
    cogIcon.addEventListener('click', (e) => {
        e.preventDefault();
        modal.classList.remove('hide');
        modal.classList.add('show');
    });

    // Auto-save on change
    eraseAllCheckbox.addEventListener("change", () => {
        localStorage.setItem('keepData', !eraseAllCheckbox.checked);
        updateConfirmText();
        updateBoardSelector();
    });

    // Click outside closes modal
    modal.addEventListener("click", (e) => {
        if (e.target === modal) {
            closeModal();
        }
    });

    if (closeBtn) {
        closeBtn.addEventListener("click", (e) => {
            e.preventDefault(); // prevents accidental form submission
            closeModal();
        });
    }

    function closeModal() {
        modal.classList.add('hide');
        setTimeout(() => {
            modal.classList.remove('show');
            modal.classList.remove('hide');
        }, 300);
    }

    // ESC key closes modal
    document.addEventListener("keydown", (e) => {
        if (e.key === "Escape" && modal.classList.contains("show")) {
            closeModal();
        }
    });
    document.body.classList.add("loaded");
    initTerminalAutoscroll();
    cacheTerminalFooter();
    bindTerminalFooterEvents();
    const footer = document.getElementById("footerVersion");
    if (footer && manifest.version) {
        footer.textContent = "v" + manifest.version;
    }
    fetchInstallCount();
});


// ================================
// TERMINAL
// ================================

let terminalPort = null;
let terminalReader = null;
let terminalKeepReading = false;
let terminalLineBuffer = "";
let terminalAutoscroll = true;
let terminalFooterOriginalHTML = null;

// ---------- STATUS UI ----------

function setTerminalStatus(state, text) {
    const dot = document.getElementById("termStatusDot");
    const label = document.getElementById("termStatusText");
    if (!dot || !label) return;
    dot.className = "dot"; // reset
    if (state === "connected") dot.classList.add("green");
    else if (state === "error") dot.classList.add("red");
    else dot.classList.add("gray");
    label.textContent = text || "";
}

// ---------- OUTPUT ----------

function terminalWrite(text, addTimestamp = true) {
    const el = document.getElementById("terminalOutput");
    if (!el) return;
    terminalLineBuffer += text;
    let lines = terminalLineBuffer.split("\n");

    // keep last partial line in buffer
    terminalLineBuffer = lines.pop();
    let output = "";
    for (const line of lines) {
        if (addTimestamp && line.trim() !== "") {
            let formattedLine = line;
            // Detect JSON payload
            const jsonStart = line.indexOf("{");
            if (jsonStart !== -1) {
                const possibleJson = line.substring(jsonStart);
                try {
                    const obj = JSON.parse(possibleJson);
                    const pretty = JSON.stringify(obj, null, 2);
                    formattedLine =
                        line.substring(0, jsonStart) +
                        "\n" +
                        pretty;
                } catch {
                    // not valid JSON → ignore
                }
            }
            const now = new Date();
            const time =
                String(now.getHours()).padStart(2, "0") + ":" +
                String(now.getMinutes()).padStart(2, "0") + ":" +
                String(now.getSeconds()).padStart(2, "0");

            output += `[${time}] ${formattedLine}\n`;
        } else {
            output += line + "\n";
        }
    }
    el.textContent += output;
    if (terminalAutoscroll) {
        el.scrollTop = el.scrollHeight;
    }
}

// ---------- CONNECT ----------

async function connectTerminal() {
    try {
        setTerminalStatus("connecting", "Connecting…");
        const output = document.getElementById("terminalOutput");
        if (output) output.textContent = "";   // clear window
        terminalPort = await navigator.serial.requestPort();
        await terminalPort.open({ baudRate: 115200 });
        terminalKeepReading = true;
        readTerminalLoop();
        setTerminalStatus("connected", "Connected to ESP Board @115200");
        terminalWrite("=== Connected ===\n\n", false);
    } catch (err) {
        console.error(err);
        setTerminalStatus("error", "Connection failed");
    }
}

// ---------- READ LOOP ----------

async function readTerminalLoop() {
    const decoder = new TextDecoder();
    try {
        terminalReader = terminalPort.readable.getReader();
        while (terminalKeepReading) {
            const { value, done } = await terminalReader.read();
            if (done) break;
            if (value) {
                terminalWrite(decoder.decode(value));
            }
        }
    } catch (err) {
        console.warn("Terminal read error:", err);
        // Device reset / USB lost
        if (err?.message?.includes("device has been lost")) {
            terminalWrite(
                "\n=== Device reset/disconnection detected. ===\n" +
                "=== Please close this window and reconnect.===\n", false
            );
            setTerminalStatus("error", "Device disconnected");
            setTerminalDisconnectedUI();
            disconnectTerminal(true);   // no await
        } else {
            terminalWrite("\nSerial error.\n");
            setTerminalStatus("error", "Serial error");
        }
    } finally {
        if (terminalReader) {
            try { terminalReader.releaseLock(); } catch { }
            terminalReader = null;
        }
    }
}

// ---------- DISCONNECT ----------

async function disconnectTerminal(silent = false) {
    terminalKeepReading = false;
    try {
        if (terminalReader) {
            try { await terminalReader.cancel(); } catch { }
            try { terminalReader.releaseLock(); } catch { }
            terminalReader = null;
        }
        if (terminalPort) {
            try { await terminalPort.close(); } catch { }
            terminalPort = null;
        }
    } catch (err) {
        console.warn("Disconnect error:", err);
    }
    if (!silent) {
        setTerminalStatus("idle", "Disconnected");
        terminalWrite("\n=== Disconnected ===\n", false);
    }
}

// ---------- MODAL OPEN ----------

async function openTerminalModal(e) {
    if (e) e.preventDefault();
    const modal = document.getElementById("terminalModal");
    if (!modal) return;
    cacheTerminalFooter();      // ensure saved
    restoreTerminalFooter();    // restore buttons
    modal.classList.remove("hide");
    modal.classList.add("show");
    await connectTerminal();
}

// ---------- MODAL CLOSE ----------

async function closeTerminalModal() {
    const modal = document.getElementById("terminalModal");
    const output = document.getElementById("terminalOutput");
    await disconnectTerminal();
    if (output) output.textContent = "";
    if (!modal) return;
    modal.classList.add("hide");
    setTimeout(() => {
        modal.classList.remove("show");
        modal.classList.remove("hide");
    }, 300);
}

// ---------- BUTTONS ----------

document.querySelector(".icon-terminal")
    ?.addEventListener("click", openTerminalModal);
document.getElementById("terminalClose")
    ?.addEventListener("click", (e) => {
        e.preventDefault();
        closeTerminalModal();
    });

// click outside closes
document.getElementById("terminalModal")
    ?.addEventListener("click", (e) => {
        if (e.target.id === "terminalModal") {
            closeTerminalModal();
        }
    });

// ESC closes modal
document.addEventListener("keydown", (e) => {
    const modal = document.getElementById("terminalModal");
    if (e.key === "Escape" && modal?.classList.contains("show")) {
        closeTerminalModal();
    }
});

function setTerminalDisconnectedUI() {
    const footer = document.querySelector(".terminal-footer");
    if (!footer) return;
    footer.innerHTML = `
        <button id="terminalCloseBtn" class="primary">Close</button>`;
    document.getElementById("terminalCloseBtn")
        ?.addEventListener("click", (e) => {
            e.preventDefault();
            closeTerminalModal();
        });
}

function showTerminalToast(message, duration = 2000) {
    const toast = document.getElementById("terminalToast");
    if (!toast) return;
    toast.textContent = message;
    toast.classList.add("show");
    clearTimeout(toast._hideTimer);
    toast._hideTimer = setTimeout(() => {
        toast.classList.remove("show");
    }, duration);
}

function initTerminalAutoscroll() {
    const saved = localStorage.getItem("terminalAutoscroll");
    terminalAutoscroll = saved !== "false";

    const el = document.getElementById("terminalOutput");
    if (el) {
        el.addEventListener("scroll", () => {
            const nearBottom =
                el.scrollTop + el.clientHeight >= el.scrollHeight - 10;
            if (!nearBottom) {
                terminalAutoscroll = false;
                const toggle = document.getElementById("terminalAutoscroll");
                if (toggle) toggle.checked = false;
                localStorage.setItem("terminalAutoscroll", "false");
            }
        });
    }
}

function cacheTerminalFooter() {
    const footer = document.querySelector(".terminal-footer");
    if (!footer) return;
    if (!terminalFooterOriginalHTML) {
        terminalFooterOriginalHTML = footer.innerHTML;
    }
}

function restoreTerminalFooter() {
    const footer = document.querySelector(".terminal-footer");
    if (!footer || !terminalFooterOriginalHTML) return;
    footer.innerHTML = terminalFooterOriginalHTML;
    // rebind events because we recreated DOM
    bindTerminalFooterEvents();
}

function bindTerminalFooterEvents() {

    const toggle = document.getElementById("terminalAutoscroll");

    if (toggle) {
        toggle.checked = terminalAutoscroll;
        toggle.addEventListener("change", () => {
            terminalAutoscroll = toggle.checked;
            localStorage.setItem("terminalAutoscroll", terminalAutoscroll);
        });
    }

    document.getElementById("terminalClear")
        ?.addEventListener("click", () => {
            const out = document.getElementById("terminalOutput");
            if (out) out.textContent = "";
        });
    document.getElementById("terminalCopy")
        ?.addEventListener("click", async () => {
            const text = document.getElementById("terminalOutput")?.textContent || "";
            try {
                await navigator.clipboard.writeText(text);
                showTerminalToast("Log copied to clipboard");
            } catch {
                showTerminalToast("Copy failed");
            }
        });
    document.getElementById("terminalDownload")
        ?.addEventListener("click", () => {
            const text = document.getElementById("terminalOutput")?.textContent || "";
            const blob = new Blob([text], { type: "text/plain" });
            const url = URL.createObjectURL(blob);
            const a = document.createElement("a");
            a.href = url;
            a.download = "esptimecast-log.txt";
            a.click();
            URL.revokeObjectURL(url);
        });
}

function generateEEPROMPayload({ magic, clk, cs, data }) {
    // Must match the C++ struct layout exactly:
    // struct PinConfig { uint8_t magic; uint8_t clk; uint8_t cs; uint8_t data; }
    const SECTOR_SIZE = 0x1000; // 4KB — EEPROM uses a full flash sector
    const payload = new Uint8Array(SECTOR_SIZE).fill(0xFF);
    payload[0] = magic; // 0xAB
    payload[1] = clk;
    payload[2] = cs;
    payload[3] = data;
    return payload;
}

function generateNVSPartition(namespace, entries) {
    const PARTITION_SIZE = 0x5000;
    const partition = new Uint8Array(PARTITION_SIZE).fill(0xFF);

    const crc32Table = (() => {
        const t = new Uint32Array(256);
        for (let i = 0; i < 256; i++) {
            let c = i;
            for (let j = 0; j < 8; j++) {
                c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
            }
            t[i] = c >>> 0;
        }
        return t;
    })();

    function crc32(bytes) {
        let crc = 0x00000000;
        for (const b of bytes) {
            crc = (crc32Table[(crc ^ b) & 0xFF] ^ (crc >>> 8)) >>> 0;
        }
        return (crc ^ 0xFFFFFFFF) >>> 0;
    }

    // --- PAGE HEADER ---
    const header = new DataView(partition.buffer, 0, 32);
    header.setUint32(0, 0xFFFFFFFE, true); // ACTIVE
    header.setUint32(4, 0, true);          // sequence number
    header.setUint8(8, 0xFE);            // version (safer)

    const headerCrc = crc32(new Uint8Array(partition.buffer, 4, 24));
    header.setUint32(28, headerCrc, true);

    let entryIdx = 0;

    // Correct bitmap handling (2 bits per entry) ---
    function markWritten(idx) {
        const byteIndex = 32 + Math.floor(idx / 4);
        const bitOffset = (idx % 4) * 2;

        partition[byteIndex] &= ~(0b11 << bitOffset);
        partition[byteIndex] |= (0b10 << bitOffset);
    }

    function writeEntry(nsIdx, type, key, valueBytes) {
        const offset = 64 + entryIdx * 32;
        const entry = new Uint8Array(partition.buffer, offset, 32);
        entry.fill(0xFF);

        entry[0] = nsIdx;
        entry[1] = type;
        entry[2] = 1;    // span
        entry[3] = 0xFF; // chunk index

        const keyBytes = new TextEncoder().encode(key);
        const writeLen = Math.min(keyBytes.length, 15);

        for (let i = 0; i < writeLen; i++) {
            entry[8 + i] = keyBytes[i];
        }

        entry[8 + writeLen] = 0x00;

        // Zero padding after null terminator
        for (let i = 8 + writeLen + 1; i < 24; i++) {
            entry[i] = 0x00;
        }
        // }

        // value (bytes 24–31)
        if (valueBytes) {
            entry.set(valueBytes, 24);
        }
        // CRC (exclude bytes 4–7)
        const crcBuf = new Uint8Array(28);
        crcBuf.set(entry.slice(0, 4), 0);
        crcBuf.set(entry.slice(8, 32), 4);
        const crc = crc32(crcBuf);

        new DataView(entry.buffer, entry.byteOffset + 4, 4)
            .setUint32(0, crc, true);

        markWritten(entryIdx++);
    }

    // Namespace entry
    const nsValue = new Uint8Array(8).fill(0xFF);
    nsValue[0] = 1;

    writeEntry(0, 0x01, namespace, nsValue); // type = NAMESPACE

    // Data entries (I32)
    for (const [key, value] of Object.entries(entries)) {
        const data = new Uint8Array(8).fill(0xFF);
        const val = parseInt(value) || 0;

        // Shift bits to the right and mask them to get each byte
        data[0] = val & 0xFF;         // Lowest byte (e.g., 10 -> 0x0A)
        data[1] = (val >> 8) & 0xFF;  // Second byte
        data[2] = (val >> 16) & 0xFF; // Third byte
        data[3] = (val >> 24) & 0xFF; // Highest byte

        // 0x14 is the magic hex code for NVS_TYPE_I32 
        writeEntry(1, 0x14, key, data);
    }

    return partition;
}

// Function to handle the Board Selector logic based on Keep Data state
function updateBoardSelector() {
    const boardSelect = document.getElementById("board-select");
    if (!boardSelect) return;

    const customOption = boardSelect.querySelector('option:last-child');

    // localStorage.getItem('keepData') === 'true' means they want to KEEP data
    const eraseAllCheckbox = document.getElementById('erase-all-data');
    if (!eraseAllCheckbox) return;

    const isKeepingData = !eraseAllCheckbox.checked;

    if (isKeepingData) {
        // 1. Hide the Custom option (usually the last one)
        if (customOption) {
            customOption.style.display = "none";
            customOption.disabled = true;
        }

        // 2. If "Custom" was currently selected, reset to the first board
        const selected = currentInstallContext?.build?.boards?.[boardSelect.value];

        if (isKeepingData && selected?.pins === null) {
            boardSelect.selectedIndex = 0;

            // Trigger UI update (pins panel etc.)
            boardSelect.dispatchEvent(new Event('change'));
        }
    } else {
        // Show the Custom option again if they decide to Erase All
        if (customOption) {
            customOption.style.display = "block";
            customOption.disabled = false;
        }
    }
}