import { defineContentScript } from "wxt/utils/define-content-script";
import { installContentController } from "../src/content/controller";

export default defineContentScript({
  registration: "runtime",
  matches: ["http://*/*", "https://*/*"],
  runAt: "document_idle",
  main() {
    // This property belongs to the extension's isolated world, not the site's window.
    const isolated = globalThis as typeof globalThis & {
      __justTranslateInstalled?: boolean;
    };
    if (isolated.__justTranslateInstalled) return;
    isolated.__justTranslateInstalled = true;
    installContentController();
  },
});
