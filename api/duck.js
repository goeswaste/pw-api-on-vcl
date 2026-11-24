import { chromium } from "playwright-core";
import crypto from "node:crypto";

// ============================================================
// CONFIGURATION
// ============================================================

const DUCK_URL = "https://duck.ai/";

const BROWSERLESS_ENDPOINT =
    process.env.BROWSERLESS_WS_ENDPOINT;

const API_SECRET =
    process.env.API_SECRET;

// Maximum time to wait for copied text.
const COPY_TIMEOUT = 10000;

// ============================================================
// SHARED RUNTIME
// ============================================================

// Reuse the browser within a warm Vercel function instance.
//
// IMPORTANT:
// Vercel does not guarantee that subsequent requests will
// reach the same function instance.

if (!globalThis.duckRelayRuntime) {

    globalThis.duckRelayRuntime = {

        browser: null,

        context: null,

        page: null,

        buttons: [],

        revision: 0,

        copyBusy: false,

        startedAt: null

    };
}

const runtime =
    globalThis.duckRelayRuntime;


// ============================================================
// AUTHENTICATION
// ============================================================

function authenticate(req) {

    if (!API_SECRET) {
        return false;
    }

    const authorization =
        req.headers.authorization || "";

    const expected =
        "Bearer " + API_SECRET;

    const actualBuffer =
        Buffer.from(authorization);

    const expectedBuffer =
        Buffer.from(expected);

    if (
        actualBuffer.length !==
        expectedBuffer.length
    ) {
        return false;
    }

    return crypto.timingSafeEqual(
        actualBuffer,
        expectedBuffer
    );
}


// ============================================================
// CLIPBOARD INTERCEPTOR
// ============================================================

const clipboardScript = `

(function() {

    "use strict";

    if (window.__duckRelayInstalled) {
        return;
    }

    window.__duckRelayInstalled = true;

    // --------------------------------------------------------
    // Internal clipboard state
    // --------------------------------------------------------

    window.__duckRelay = {

        activeID: "",

        lastCopied: null,

        sequence: 0

    };


    // --------------------------------------------------------
    // Capture copied text
    // --------------------------------------------------------

    function captureText(text) {

        if (
            text === null ||
            typeof text === "undefined"
        ) {
            return;
        }

        text = String(text);

        if (!text) {
            return;
        }

        var id =
            window.__duckRelay.activeID;

        if (!id) {
            return;
        }

        window.__duckRelay.sequence++;

        window.__duckRelay.lastCopied = {

            id: id,

            text: text,

            sequence:
                window.__duckRelay.sequence,

            timestamp: Date.now()

        };

    }


    // --------------------------------------------------------
    // Find Copy button ID
    // --------------------------------------------------------

    function findCopyID(element) {

        var current = element;

        for (
            var i = 0;
            i < 30 && current;
            i++
        ) {

            if (
                current.getAttribute
            ) {

                var id =
                    current.getAttribute(
                        "data-swift-copy-id"
                    );

                if (id) {
                    return id;
                }

            }

            current =
                current.parentElement;
        }

        return "";

    }


    // --------------------------------------------------------
    // Remember clicked button
    // --------------------------------------------------------

    document.addEventListener(

        "click",

        function(event) {

            try {

                var path =
                    event.composedPath
                    ? event.composedPath()
                    : [event.target];

                for (
                    var i = 0;
                    i < path.length;
                    i++
                ) {

                    var element = path[i];

                    if (
                        element &&
                        element.getAttribute
                    ) {

                        var id =
                            element.getAttribute(
                                "data-swift-copy-id"
                            );

                        if (id) {

                            window.__duckRelay.activeID =
                                id;

                            return;
                        }

                    }

                }

            } catch(e) {}

        },

        true

    );


    // --------------------------------------------------------
    // Modern Clipboard API
    // --------------------------------------------------------

    try {

        if (
            navigator.clipboard
        ) {

            var clipboard =
                navigator.clipboard;

            var interceptedWriteText =
                function(text) {

                    captureText(text);

                    // We have captured the text.
                    // Return a successful Promise without
                    // requiring access to the host clipboard.

                    return Promise.resolve();

                };

            try {

                Object.defineProperty(

                    clipboard,

                    "writeText",

                    {
                        configurable: true,
                        value: interceptedWriteText
                    }

                );

            } catch(e) {

                try {

                    clipboard.writeText =
                        interceptedWriteText;

                } catch(e2) {}

            }

        }

    } catch(e) {}


    // --------------------------------------------------------
    // Legacy execCommand("copy")
    // --------------------------------------------------------

    try {

        var originalExecCommand =
            document.execCommand;

        document.execCommand =
            function(command) {

                var copiedText = "";

                try {

                    if (
                        String(command).toLowerCase()
                        === "copy"
                    ) {

                        var selection =
                            window.getSelection();

                        if (selection) {

                            copiedText =
                                selection.toString();

                        }

                    }

                } catch(e) {}

                var result =
                    originalExecCommand.apply(
                        this,
                        arguments
                    );

                if (
                    String(command).toLowerCase()
                    === "copy"
                ) {

                    captureText(copiedText);

                }

                return result;

            };

    } catch(e) {}


    // --------------------------------------------------------
    // Clipboard event
    // --------------------------------------------------------

    document.addEventListener(

        "copy",

        function(event) {

            try {

                if (
                    event.clipboardData
                ) {

                    var text =
                        event.clipboardData.getData(
                            "text/plain"
                        );

                    if (text) {
                        captureText(text);
                    }

                }

            } catch(e) {}

        },

        true

    );


})();

`;


// ============================================================
// COPY BUTTON SCANNER
// ============================================================

const scannerScript = `

(function() {

    "use strict";

    function getText(element) {

        try {

            return (

                element.innerText ||
                element.textContent ||
                ""

            ).trim();

        } catch(e) {

            return "";

        }

    }


    function getAttribute(element, name) {

        try {

            return (

                element.getAttribute(name) ||
                ""

            ).trim();

        } catch(e) {

            return "";

        }

    }


    // --------------------------------------------------------
    // Determine whether an element is a Copy button
    // --------------------------------------------------------

    function looksLikeCopyButton(element) {

        var combined = [

            getText(element),

            getAttribute(element, "aria-label"),

            getAttribute(element, "title"),

            getAttribute(element, "data-testid"),

            getAttribute(element, "data-tooltip")

        ].join(" ").toLowerCase();


        return (

            combined.indexOf("copy") >= 0 ||

            combined.indexOf("clipboard") >= 0

        );

    }


    // --------------------------------------------------------
    // Assign stable ID
    // --------------------------------------------------------

    function makeID(element, index) {

        var existing =
            getAttribute(
                element,
                "data-swift-copy-id"
            );

        if (existing) {
            return existing;
        }

        var id =

            "swift-copy-" +

            index +

            "-" +

            Math.random()
                .toString(36)
                .substring(2, 10);


        element.setAttribute(

            "data-swift-copy-id",

            id

        );

        return id;

    }


    // --------------------------------------------------------
    // Recursive DOM / Shadow DOM scanner
    // --------------------------------------------------------

    function scanRoot(root, results, seen) {

        if (!root) {
            return;
        }

        var elements = [];

        try {

            elements =
                root.querySelectorAll("*");

        } catch(e) {

            return;

        }


        for (
            var i = 0;
            i < elements.length;
            i++
        ) {

            var element =
                elements[i];


            // ------------------------------------------------
            // Copy button detection
            // ------------------------------------------------

            if (

                (
                    element.matches(
                        "button, [role='button'], " +
                        "[role='menuitem'], [tabindex], " +
                        "[data-testid], [aria-label], [title]"
                    )
                ) &&

                looksLikeCopyButton(element)

            ) {

                if (!seen.has(element)) {

                    seen.add(element);

                    var id =
                        makeID(
                            element,
                            results.length
                        );

                    var title =
                        getText(element) ||

                        getAttribute(
                            element,
                            "aria-label"
                        ) ||

                        getAttribute(
                            element,
                            "title"
                        ) ||

                        "Copy";


                    results.push({

                        id: id,

                        title: title

                    });

                }

            }


            // ------------------------------------------------
            // Shadow DOM
            // ------------------------------------------------

            try {

                if (element.shadowRoot) {

                    scanRoot(

                        element.shadowRoot,

                        results,

                        seen

                    );

                }

            } catch(e) {}

        }

    }


    // --------------------------------------------------------
    // Public scanner
    // --------------------------------------------------------

    window.swiftRescanCopyButtons = function() {

        var results = [];

        var seen = new Set();


        scanRoot(

            document,

            results,

            seen

        );


        return results;

    };


})();

`;


// ============================================================
// CONNECT TO BROWSERLESS
// ============================================================

async function connectBrowser() {

    if (
        runtime.browser &&
        runtime.browser.isConnected()
    ) {

        return runtime.page;

    }


    if (!BROWSERLESS_ENDPOINT) {

        throw new Error(
            "BROWSERLESS_WS_ENDPOINT is missing"
        );

    }


    console.log(
        "Connecting to Browserless..."
    );


    const browser =
        await chromium.connectOverCDP(

            BROWSERLESS_ENDPOINT,

            {
                timeout: 60000
            }

        );


    const contexts =
        browser.contexts();

    const context =
        contexts.length
        ? contexts[0]
        : await browser.newContext();


    let page =
        context.pages().find(

            p => p.url().includes("duck.ai")

        );


    if (!page) {

        page =
            await context.newPage();

    }


    // Install interceptors before navigation.

    await page.addInitScript({

        content: clipboardScript

    });


    await page.addInitScript({

        content: scannerScript

    });


    try {

        await context.grantPermissions(

            [
                "clipboard-read",
                "clipboard-write"
            ],

            {
                origin: "https://duck.ai"
            }

        );

    } catch(e) {}


    runtime.browser = browser;

    runtime.context = context;

    runtime.page = page;


    browser.on("disconnected", () => {

        console.log(
            "Browserless disconnected"
        );

        runtime.browser = null;

        runtime.context = null;

        runtime.page = null;

    });


    if (
        !page.url().includes("duck.ai")
    ) {

        await page.goto(

            DUCK_URL,

            {
                waitUntil: "domcontentloaded",
                timeout: 60000
            }

        );

    }


    runtime.startedAt =
        new Date().toISOString();


    console.log(
        "Duck.ai browser ready"
    );


    return page;

}


// ============================================================
// ENSURE BROWSER
// ============================================================

async function ensurePage() {

    const page =
        await connectBrowser();


    if (page.isClosed()) {

        runtime.page = null;

        throw new Error(
            "Browser page was closed"
        );

    }


    return page;

}


// ============================================================
// SCAN COPY BUTTONS
// ============================================================

async function scanCopyButtons() {

    const page =
        await ensurePage();


    const results =
        await page.evaluate(() => {

            if (
                typeof window.swiftRescanCopyButtons
                !== "function"
            ) {

                return [];

            }

            return window.swiftRescanCopyButtons();

        });


    const changed =

        JSON.stringify(results) !==

        JSON.stringify(runtime.buttons);


    if (changed) {

        runtime.buttons = results;

        runtime.revision++;

        console.log(
            "Copy buttons updated:",
            results.length
        );

    }


    return {

        buttons: runtime.buttons,

        revision: runtime.revision

    };

}


// ============================================================
// CLICK COPY BUTTON AND CAPTURE TEXT
// ============================================================

async function clickCopyButton(id) {

    if (runtime.copyBusy) {

        throw new Error(
            "Another copy operation is running"
        );

    }


    runtime.copyBusy = true;


    try {

        const page =
            await ensurePage();


        // Refresh button list.

        const state =
            await scanCopyButtons();


        const button =
            state.buttons.find(

                item => item.id === id

            );


        if (!button) {

            throw new Error(
                "Copy button not found"
            );

        }


        // Get current clipboard sequence.

        const previousSequence =
            await page.evaluate(() => {

                return (

                    window.__duckRelay &&
                    window.__duckRelay.lastCopied

                )
                ? window.__duckRelay.lastCopied.sequence
                : 0;

            });


        // ----------------------------------------------------
        // Find and click button, including Shadow DOM.
        // ----------------------------------------------------

        const clicked =
            await page.evaluate((targetID) => {

                function find(root) {

                    if (!root) {
                        return null;
                    }

                    var elements =
                        root.querySelectorAll("*");


                    for (
                        var i = 0;
                        i < elements.length;
                        i++
                    ) {

                        var element =
                            elements[i];


                        if (

                            element.getAttribute(

                                "data-swift-copy-id"

                            ) === targetID

                        ) {

                            return element;

                        }


                        if (element.shadowRoot) {

                            var found =
                                find(element.shadowRoot);

                            if (found) {
                                return found;
                            }

                        }

                    }

                    return null;

                }


                var element =
                    find(document);


                if (!element) {
                    return false;
                }


                element.click();

                return true;

            }, id);


        if (!clicked) {

            throw new Error(
                "Could not activate Copy button"
            );

        }


        // ----------------------------------------------------
        // Wait for actual copied text.
        // ----------------------------------------------------

        await page.waitForFunction(

            ({ targetID, oldSequence }) => {

                var state =
                    window.__duckRelay;

                if (!state || !state.lastCopied) {
                    return false;
                }

                return (

                    state.lastCopied.id === targetID &&

                    state.lastCopied.sequence > oldSequence &&

                    state.lastCopied.text.length > 0

                );

            },

            {

                targetID: id,

                oldSequence: previousSequence

            },

            {

                timeout: COPY_TIMEOUT

            }

        );


        // ----------------------------------------------------
        // Retrieve captured text.
        // ----------------------------------------------------

        const captured =
            await page.evaluate(() => {

                return window.__duckRelay.lastCopied;

            });


        if (
            !captured ||
            captured.id !== id
        ) {

            throw new Error(
                "Captured text does not match requested button"
            );

        }


        console.log(

            "Captured Duck.ai copy:",

            id,

            "Length:",

            captured.text.length

        );


        return {

            id: id,

            text: captured.text,

            length: captured.text.length,

            timestamp: captured.timestamp

        };


    } finally {

        runtime.copyBusy = false;

    }

}


// ============================================================
// STOP BROWSER
// ============================================================

async function stopBrowser() {

    if (runtime.browser) {

        await runtime.browser.close();

    }


    runtime.browser = null;

    runtime.context = null;

    runtime.page = null;

    runtime.buttons = [];

    runtime.revision = 0;

    runtime.startedAt = null;


    return {

        success: true,

        message: "Browser stopped"

    };

}


// ============================================================
// HTTP RESPONSE
// ============================================================

function respond(res, status, data) {

    res.status(status);

    res.setHeader(

        "Content-Type",

        "application/json; charset=utf-8"

    );

    res.setHeader(

        "Cache-Control",

        "no-store"

    );

    res.json(data);

}


// ============================================================
// MAIN API ROUTER
// ============================================================

export const config = {

    api: {

        bodyParser: {

            sizeLimit: "1mb"

        }

    }

};


export const maxDuration = 60;


export default async function handler(req, res) {


    // --------------------------------------------------------
    // Authentication
    // --------------------------------------------------------

    if (!authenticate(req)) {

        return respond(

            res,

            401,

            {

                error: "Unauthorized"

            }

        );

    }


    const pathname =

        new URL(

            req.url,

            "https://localhost"

        ).pathname;


    try {


        // ====================================================
        // START
        // ====================================================

        if (

            req.method === "POST" &&

            pathname === "/api/start"

        ) {

            const page =
                await ensurePage();


            const state =
                await scanCopyButtons();


            return respond(

                res,

                200,

                {

                    success: true,

                    url: page.url(),

                    ...state

                }

            );

        }


        // ====================================================
        // STATUS
        // ====================================================

        if (

            req.method === "GET" &&

            pathname === "/api/status"

        ) {

            return respond(

                res,

                200,

                {

                    connected:

                        !!runtime.browser &&
                        runtime.browser.isConnected(),

                    page:

                        runtime.page
                        ? runtime.page.url()
                        : null,

                    startedAt:
                        runtime.startedAt

                }

            );

        }


        // ====================================================
        // STATE
        // ====================================================

        if (

            req.method === "GET" &&

            pathname === "/api/state"

        ) {

            const state =
                await scanCopyButtons();


            return respond(

                res,

                200,

                state

            );

        }


        // ====================================================
        // COPY
        // ====================================================

        if (

            req.method === "POST" &&

            pathname === "/api/copy"

        ) {

            const id =
                req.body && req.body.id;


            if (!id) {

                return respond(

                    res,

                    400,

                    {

                        error: "Missing button ID"

                    }

                );

            }


            const result =
                await clickCopyButton(id);


            return respond(

                res,

                200,

                result

            );

        }


        // ====================================================
        // STOP
        // ====================================================

        if (

            req.method === "POST" &&

            pathname === "/api/stop"

        ) {

            const result =
                await stopBrowser();


            return respond(

                res,

                200,

                result

            );

        }


        // ====================================================
        // NOT FOUND
        // ====================================================

        return respond(

            res,

            404,

            {

                error: "Endpoint not found"

            }

        );


    } catch(error) {


        console.error(

            "Duck Relay Error:",

            error

        );


        return respond(

            res,

            500,

            {

                error: error.message

            }

        );

    }

}