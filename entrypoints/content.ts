import { defineContentScript } from "wxt/utils/define-content-script";
import { installContentController } from "../src/content/controller";

export default defineContentScript({
  registration: "runtime",
  // Inject only after a shortcut gesture using activeTab. Runtime `matches`
  // would make WXT request permanent access to every matching website.
  runAt: "document_idle",
  main(ctx) {
    // This property belongs to the extension's isolated world, not the site's window.
    const isolated = globalThis as typeof globalThis & {
      __justTranslateDispose?: () => void;
    };
    isolated.__justTranslateDispose?.();
    if (ctx.isInvalid) return;
    const uninstall = installContentController(() => ctx.isValid);
    const dispose = (): void => {
      removeInvalidationListener();
      if (isolated.__justTranslateDispose === dispose)
        delete isolated.__justTranslateDispose;
      uninstall();
    };
    const removeInvalidationListener = ctx.onInvalidated(dispose);
    isolated.__justTranslateDispose = dispose;
    // onInvalidated does not replay an abort that happened before registration.
    if (ctx.isInvalid) dispose();
  },
});
