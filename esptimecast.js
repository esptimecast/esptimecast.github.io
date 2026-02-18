/**
 * ESPTimeCast Web Installer
 */
function isSupportedBrowser() {
    const isChromium = !!window.chrome && !!navigator.serial;
    const isMobile = /Android|iPhone|iPad|iPod/i.test(navigator.userAgent);
    return isChromium && !isMobile;
}
import { Transport, ESPLoader } from './esptools.js';

/* ============================================================
   SECTION 1-4: (UTILITIES, SLIP, PACKETS, MANIFEST) - UNCHANGED
   ============================================================ */
async function safeClosePort(port) {
    if (!port) return;
    try {
        // Cancel any pending reads/writes
        if (port.readable) {
            try { await port.readable.cancel(); } catch (e) { }
        }
        if (port.writable) {
            try {
                const writer = port.writable.getWriter();
                writer.releaseLock();
            } catch (e) { }
        }
        // Close the port itself
        if (port.close) {
            await port.close();
        }
    } catch (e) {
        log("⚠️ Error closing port: " + e.message);
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
    version: "1.0.1",
    builds: []
};

const basePath = `v${manifest.version}/`;

manifest.builds = [
    {
        chipFamily: "ESP8266",
        factory: basePath + "esp8266.bin",
        update: basePath + "esp8266.bin"
    },
    {
        chipFamily: "ESP32",
        factory: basePath + "esp32_full.bin",
        update: basePath + "esp32_app.bin"
    },
    {
        chipFamily: "ESP32-C3",
        factory: basePath + "esp32c3_full.bin",
        update: basePath + "esp32c3_app.bin"
    },
    {
        chipFamily: "ESP32-S2",
        factory: basePath + "esp32s2_full.bin",
        update: basePath + "esp32s2_app.bin"
    },
    {
        chipFamily: "ESP32-S3",
        factory: basePath + "esp32s3_full.bin",
        update: basePath + "esp32s3_app.bin"
    }
];

/* ============================================================
   SECTION 5: INSTALL CONFIRMATION UI
   ============================================================ */
async function flashFirmwareWithRetry(port, chip, firmwarePath, maxRetries = 3) {
    let currentPort = port;
    slideFlashing();
    for (let attempt = 1; attempt <= maxRetries; attempt++) {
        const startTime = Date.now(); // Record start time

        try {
            log(`Flash attempt ${attempt} of ${maxRetries}...`);
            await flashFirmware(currentPort, chip, firmwarePath);
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
                await safeClosePort(currentPort); // Just close it, don't forget it
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
        `<strong>${chip}</strong> detected`;

    currentInstallContext = { build, version };

    updateConfirmText(false);
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

        await flashFirmwareWithRetry(port, chip, "bins/" + selectedFirmware);
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

        // If PID detected C3, treat it as non-S2: open port and continue to magic detection
        if (chipByPID === "ESP32-C3") log("ESP32-C3 detected via USB PID — continuing with flash detection");

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
        writer.releaseLock();
        reader.releaseLock();
        writer = null;
        reader = null;

        if (result !== "ESP32-S2") {
            await port.close();
            log("Port closed. Ready for flasher handover.");
        }

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
        if (writer) writer.releaseLock();
        if (reader) reader.releaseLock();
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

async function flashFirmware(port, chip, firmwarePath) {
    log("Starting flash using esptool-js...");
    const initStart = Date.now();
    if (chip === "ESP32-S2") {
        log("ESP32-S2: native USB handling enabled");
    }

    let transport = null;
    try {
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
                    const percent = parseFlashProgress(msg);
                    if (percent !== null) {
                        updateProgressRing(percent);
                    }

                    handleFlashStageMessage(msg);
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
        let binaryString = "";
        const CHUNK_SIZE = 8192;
        for (let i = 0; i < uint8.length; i += CHUNK_SIZE) {
            binaryString += String.fromCharCode.apply(null, uint8.subarray(i, i + CHUNK_SIZE));
        }
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
        const fileArray = [{ data: binaryString, address: flashAddress }];
        await loader.writeFlash({
            fileArray,
            flashSize: "keep",
            eraseAll: !keepData,
            compress: true,
            reportProgress: (fraction) => {
                const percent = Math.round(fraction * 100);
                if (percent > 0) updateProgressRing(percent);
            }
        }
        );
        // 🔹 Flash finished
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
                // Perform reset for UART boards, including ESP32-S3 if connected via UART
                log(`Will perform UART reset for ${chip}...`);

                await transport.setDTR(false); // Pull DTR low to reset
                await sleep(100);             // Short delay for stabilization
                await transport.setDTR(true); // Release DTR
                await transport.disconnect(); // Disconnect the transport
                log(`✅ ${chip} UART reset complete.`);
                installSuccess(true);
            } else if (chip === "ESP32-S3" && port.getInfo().usbVendorId === 0x303a) {
                // ESP32-S3 connected via OTG (Native USB)
                log("UART reset not available on ESP32-S3 connected via OTG (Native USB). Skipping reset.");
                installSuccess(false);
            } else {
                // Skip reset for other native USB boards
                installSuccess(false);
                log(`UART reset not available on this board: ${chip}`);
            }
        } catch (e) {
            // Handle errors during reset
            log("⚠️ Reboot handling failed: " + e.message);
            // Ensure the transport is cleaned up
            try { await transport.disconnect(); } catch (disconnectError) {
                log("Transport disconnect failed: " + disconnectError.message);
            }
        }


        log("Installation complete! Device should now reboot.");

        try {
            // Make absolutely sure transport is gone
            try { await transport?.disconnect(); } catch { }
            // Explicitly close the Web Serial port so the browser releases it
            if (port?.readable || port?.writable) {
                await port.close();
                log("🔌 Serial port closed cleanly");
            }
        } catch (e) {
            log("⚠️ Final port cleanup failed: " + e.message);
        }
    } catch (err) {
        log("❌ Flash Error: " + err.message);
        console.error(err);
        // Aggressive cleanup
        try {
            if (transport) await transport.disconnect();
        } catch (e) {
            log("Disconnect error: " + e.message);
        }
        await safeClosePort(port);
        throw err;
    }
}


//** 
//progress indicator
//** 
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

//**
//screens
//**
async function slideFlashing() {
    goToSlide("flashing");
    resetFlashingUI();
}

function installSuccess(isUart = true) {

    const message = isUart
        ? "<b>ESPTimeCast</b> is now running."
        : "Press <b>RESET</b> or reconnect to start <b>ESPTimeCast</b>.";

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

    document.getElementById("reflash").onclick = () => {
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
    const defaultText = `© ${year} ESPTimeCast. All rights reserved.`;

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
    const stepper = document.querySelector(".stepper");
    const hints = document.querySelector(".hints");

    // Remove Start button
    if (startBtn) startBtn.remove();

    // Prevent duplicate manual button
    if (!heroSlide.querySelector(".manual-btn")) {
        const manualBtn = document.createElement("a");
        manualBtn.href = "https://github.com/mfactory-osaka/ESPTimeCast";
        manualBtn.target = "_blank";
        manualBtn.rel = "noopener noreferrer";
        manualBtn.className = "manual-btn";
        manualBtn.textContent = "View Manual Installation Guide";

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
        ? `Updating to <strong>v${version}</strong><br>
           Your settings and Wi-Fi configuration will be preserved.`
        : `Installing <strong>v${version}</strong> will erase all settings and data.<br>
           This action cannot be undone.`;

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

});

