import { defineConfig } from "wxt";

export default defineConfig({
  manifestVersion: 3,
  manifest: {
    name: "Just Translate",
    description: "用自己的 AI 模型，一键翻译当前页；支持双语或只显示译文，自动补译新内容。",
    minimum_chrome_version: "120",
    permissions: ["activeTab", "scripting", "storage"],
    optional_host_permissions: [
      "https://*/*",
      "http://localhost/*",
      "http://127.0.0.1/*",
      "http://[::1]/*",
    ],
    action: {
      default_title: "打开 Just Translate 设置",
      default_icon: {
        16: "icon/16.png",
        32: "icon/32.png",
        48: "icon/48.png",
        128: "icon/128.png",
      },
    },
    commands: {
      "toggle-translation": {
        suggested_key: { default: "Alt+Q", mac: "Alt+Q" },
        description: "切换原文 / 译文",
      },
    },
    icons: {
      16: "icon/16.png",
      32: "icon/32.png",
      48: "icon/48.png",
      128: "icon/128.png",
    },
  },
});
