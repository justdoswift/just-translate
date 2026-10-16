import assert from "node:assert/strict";
import { cp, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import type { CDPSession, Page, Worker } from "playwright";

// Only the disposable copy receives this instrumentation. Capture the listener
// before production background initialization; never expose a production test API.
export async function instrumentExtension(profile: string): Promise<string> {
  const extension = path.join(profile, "test-extension");
  await cp(path.resolve(".output/chrome-mv3"), extension, { recursive: true });
  const manifestPath = path.join(extension, "manifest.json");
  const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
  const originalWorker = manifest.background.service_worker;
  await writeFile(
    path.join(extension, "test-capture.js"),
    `(() => {
      let markReady;
      const harness = globalThis.__justTranslateBrowserTest = {
        commandListeners: [], pageReads: 0,
        ready: new Promise(resolve => markReady = resolve)
      };
      const addListener = chrome.commands.onCommand.addListener.bind(chrome.commands.onCommand);
      chrome.commands.onCommand.addListener = (listener) => {
        harness.commandListeners.push(listener);
        const result = addListener(listener);
        markReady();
        return result;
      };
      const executeScript = chrome.scripting.executeScript.bind(chrome.scripting);
      chrome.scripting.executeScript = (...args) => {
        harness.pageReads++;
        return executeScript(...args);
      };
      const sendMessage = chrome.tabs.sendMessage.bind(chrome.tabs);
      chrome.tabs.sendMessage = (...args) => {
        harness.pageReads++;
        return sendMessage(...args);
      };
    })();`,
  );
  await writeFile(
    path.join(extension, "test-background.js"),
    manifest.background.type === "module"
      ? `import "./test-capture.js";\nimport ${JSON.stringify(`./${originalWorker}`)};\n`
      : `importScripts("test-capture.js", ${JSON.stringify(originalWorker)});\n`,
  );
  manifest.background.service_worker = "test-background.js";
  await writeFile(manifestPath, JSON.stringify(manifest));
  return extension;
}

// Dispatch the actual registered command callback with a real Chrome tab. This
// does not exercise native keyboard delivery or the command's activeTab grant.
export async function dispatchTranslationCommand(
  worker: Worker,
  page: Page,
): Promise<void> {
  await page.bringToFront();
  await worker.evaluate(`(async () => {
    const listeners = globalThis.__justTranslateBrowserTest.commandListeners;
    if (listeners.length !== 1) throw new Error("Expected one production command listener");
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (tab?.id === undefined) throw new Error("No active command target");
    await listeners[0]("toggle-translation", tab);
  })()`);
}

export async function pageReadCount(worker: Worker): Promise<number> {
  return worker.evaluate("globalThis.__justTranslateBrowserTest.pageReads");
}

// A real toolbar gesture grants activeTab in the permission suite. Its only
// application effect must be opening settings, never starting/stopping a page.
export async function clickToolbar(
  cdp: CDPSession,
  extensionId: string,
  page: Page,
): Promise<void> {
  await page.bringToFront();
  const { targetInfos } = await cdp.send("Target.getTargets", {
    filter: [{ type: "tab", exclude: false }, { exclude: true }],
  });
  const target = targetInfos.find((entry) => entry.url === page.url());
  assert.ok(target);
  await cdp.send("Extensions.triggerAction", {
    id: extensionId,
    targetId: target.targetId,
  });
}
