import { Effects } from "@crowbartools/firebot-custom-scripts-types/types/effects";
import { promises as fsp } from "fs";
import * as path from "path";
import {
    PLUGIN_ID,
    PLUGIN_NAME
} from "../constants";
import { MeldRemote } from "../meld/meld-remote";
import { PluginLogger } from "../plugin-logger";

const IMAGE_EXTENSIONS = new Set([".png", ".jpg", ".jpeg", ".webp", ".bmp"]);

const CAPTURE_TIMEOUT_MS = 3000;
const CAPTURE_POLL_INTERVAL_MS = 50;

const sleep = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));

// Captures are serialized so two firing close together can't confuse each
// other's before/after snapshots of Meld's screenshot folder.
let captureChain: Promise<unknown> = Promise.resolve();

async function listImageFiles(dir: string): Promise<string[]> {
    const entries = await fsp.readdir(dir, { withFileTypes: true });
    return entries
        .filter(e => e.isFile() && IMAGE_EXTENSIONS.has(path.extname(e.name).toLowerCase()))
        .map(e => e.name);
}

/**
 * Waits for a new image file to appear in `dir` (one not present in `existing`)
 * and returns its full path once its size has stopped growing. Returns null if
 * nothing usable shows up before the timeout.
 */
async function waitForNewScreenshot(dir: string, existing: Set<string>): Promise<string | null> {
    const deadline = Date.now() + CAPTURE_TIMEOUT_MS;
    let candidate: string | null = null;
    let lastSize = -1;

    while (Date.now() < deadline) {
        await sleep(CAPTURE_POLL_INTERVAL_MS);

        let names: string[];
        try {
            names = await listImageFiles(dir);
        } catch {
            continue;
        }

        const fresh = names.filter(n => !existing.has(n));
        if (fresh.length === 0) {
            continue;
        }

        // Pick the most recently created of the new files.
        let newest: { name: string; ctimeMs: number; size: number } | null = null;
        for (const name of fresh) {
            try {
                const stat = await fsp.stat(path.join(dir, name));
                if (newest == null || stat.ctimeMs > newest.ctimeMs) {
                    newest = { name, ctimeMs: stat.ctimeMs, size: stat.size };
                }
            } catch {
                // File may have been removed between readdir and stat; ignore.
            }
        }

        if (newest == null) {
            continue;
        }

        // Only return once the file has a stable, non-zero size so we never
        // move a screenshot Meld is still writing.
        if (newest.name === candidate && newest.size === lastSize && newest.size > 0) {
            return path.join(dir, newest.name);
        }

        candidate = newest.name;
        lastSize = newest.size;
    }

    if (candidate != null && lastSize > 0) {
        return path.join(dir, candidate);
    }

    return null;
}

async function moveScreenshot(
    sourcePath: string,
    destFolder: string,
    fileName: string,
    overwrite: boolean
): Promise<string | null> {
    const sourceExt = path.extname(sourcePath) || ".png";
    const hasImageExt = IMAGE_EXTENSIONS.has(path.extname(fileName).toLowerCase());
    const destPath = path.join(destFolder, hasImageExt ? fileName : `${fileName}${sourceExt}`);

    await fsp.mkdir(destFolder, { recursive: true });

    let destExists = false;
    try {
        await fsp.access(destPath);
        destExists = true;
    } catch {
        destExists = false;
    }

    if (destExists && !overwrite) {
        PluginLogger.logWarn(`Destination ${destPath} already exists and overwrite is disabled; leaving the Meld screenshot in place.`);
        return null;
    }

    if (destExists) {
        try {
            await fsp.unlink(destPath);
        } catch {
            // Fall through; rename below will surface any real problem.
        }
    }

    try {
        await fsp.rename(sourcePath, destPath);
    } catch (err: any) {
        // rename fails across volumes (e.g. Meld's folder and the destination
        // are on different drives); fall back to copy + delete.
        if (err != null && err.code === "EXDEV") {
            await fsp.copyFile(sourcePath, destPath);
            await fsp.unlink(sourcePath);
        } else {
            throw err;
        }
    }

    return destPath;
}

export const TakeSceneScreenshotEffect: Effects.EffectType<{
    outputFolder: string,
    fileName: string,
    overwrite: boolean,
    vertical: boolean
}> = {
    definition: {
        id: `${PLUGIN_ID}:take-scene-screenshot`,
        name: `${PLUGIN_NAME}: Take Scene Screenshot`,
        description: "Takes a screenshot of the current scene and saves it to a folder with a custom filename",
        icon: "fad fa-camera",
        categories: ["common"],
        outputs: [
            {
                label: "Screenshot File Path",
                description: "The full path of the saved screenshot file, or empty if the screenshot could not be saved.",
                defaultName: "meldScreenshotPath"
            }
        ]
    },
    optionsTemplate: `
        <eos-container ng-show="screenshotDir == null || screenshotDir === ''">
            <div class="effect-info alert alert-warning">
                <p><b>Warning!</b>
                    No Meld screenshot folder is configured. Set the <b>Meld Screenshot Folder</b> in this plugin's
                    settings (Settings &gt; Scripts) so this effect knows where Meld saves screenshots.
                </p>
            </div>
        </eos-container>

        <eos-container header="Output Folder">
            <p class="muted">The folder to move each screenshot into.</p>
            <file-chooser
                model="effect.outputFolder"
                options="{ directoryOnly: true, filters: [], title: 'Select Output Folder', buttonLabel: 'Select Folder' }"
                on-update="effect.outputFolder = filepath">
            </file-chooser>
        </eos-container>

        <eos-container header="File Name" pad-top="true">
            <p class="muted">
                The file name to save as, without extension. Supports variables, e.g.
                <code>$math[$unixTimestamp % 10]</code> to keep one image per second of the last 10 seconds.
            </p>
            <firebot-input model="effect.fileName" input-title="File Name" placeholder-text="Enter a file name..."></firebot-input>
        </eos-container>

        <eos-container header="Options" pad-top="true">
            <label class="control-fb control--checkbox">Overwrite existing file
                <input type="checkbox" ng-model="effect.overwrite">
                <div class="control__indicator"></div>
            </label>
            <label class="control-fb control--checkbox">Vertical screenshot
                <input type="checkbox" ng-model="effect.vertical">
                <div class="control__indicator"></div>
            </label>
        </eos-container>
    `,
    optionsController: ($scope: any, backendCommunicator: any) => {
        $scope.screenshotDir = backendCommunicator.fireEventSync("meld:get-screenshot-dir");

        if ($scope.effect.overwrite == null) {
            $scope.effect.overwrite = true;
        }
    },
    optionsValidator: (effect) => {
        const errors = [];
        if (effect.outputFolder == null || effect.outputFolder === "") {
            errors.push("Please select an output folder.");
        }
        if (effect.fileName == null || effect.fileName === "") {
            errors.push("Please enter a file name.");
        }
        return errors;
    },
    getDefaultLabel: (effect) => {
        return effect.fileName;
    },
    onTriggerEvent: async ({ effect }) => {
        const failure = { success: true, outputs: { meldScreenshotPath: "" } };

        const screenshotDir = MeldRemote.getScreenshotDir();
        if (!screenshotDir) {
            PluginLogger.logWarn("Cannot take screenshot: no Meld screenshot folder is configured in the plugin settings.");
            return failure;
        }

        if (!MeldRemote.isConnected()) {
            PluginLogger.logWarn("Cannot take screenshot: Meld Studio is not connected.");
            return failure;
        }

        if (!effect.outputFolder || !effect.fileName) {
            PluginLogger.logWarn("Cannot take screenshot: output folder or file name is missing.");
            return failure;
        }

        const run = captureChain.then(async (): Promise<string> => {
            let existing: Set<string>;
            try {
                existing = new Set(await listImageFiles(screenshotDir));
            } catch (err) {
                PluginLogger.logWarn(`Cannot read Meld screenshot folder ${screenshotDir}: ${err}`);
                return "";
            }

            MeldRemote.takeScreenshot(effect.vertical === true);

            const sourcePath = await waitForNewScreenshot(screenshotDir, existing);
            if (sourcePath == null) {
                PluginLogger.logWarn("Timed out waiting for Meld to write the screenshot file.");
                return "";
            }

            try {
                const destPath = await moveScreenshot(
                    sourcePath,
                    effect.outputFolder,
                    effect.fileName,
                    effect.overwrite === true
                );
                if (destPath != null) {
                    PluginLogger.logDebug(`Saved Meld screenshot to ${destPath}`);
                    return destPath;
                }
                return "";
            } catch (err) {
                PluginLogger.logWarn(`Failed to move Meld screenshot: ${err}`);
                return "";
            }
        }).catch((err): string => {
            PluginLogger.logWarn(`Screenshot effect error: ${err}`);
            return "";
        });

        captureChain = run;
        const savedPath = await run;

        return { success: true, outputs: { meldScreenshotPath: savedPath } };
    }
}
