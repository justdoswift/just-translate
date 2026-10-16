import assert from "node:assert/strict";
import test from "node:test";
import { apiOriginPattern, normalizeBaseUrl } from "../src/shared";

test("provider base paths are preserved without duplicating the completion route", () => {
  assert.equal(
    normalizeBaseUrl("  https://models.example.test/openai/v1/// "),
    "https://models.example.test/openai/v1",
  );
  assert.equal(
    normalizeBaseUrl("https://api.deepseek.com/"),
    "https://api.deepseek.com",
  );
  assert.throws(
    () => normalizeBaseUrl("https://models.example.test/v1/chat/completions"),
    /基础地址/,
  );
});

test("remote credentials cannot be sent to insecure or URL-embedded destinations", () => {
  for (const url of [
    "http://api.example.test/v1",
    "https://secret@api.example.test/v1",
    "https://user:secret@api.example.test/v1",
    "https://api.example.test/v1?key=secret",
    "https://api.example.test/v1#secret",
    "file:///tmp/model",
    "javascript:alert(1)",
    "http://127.0.0.1.example.test/v1",
  ])
    assert.throws(() => normalizeBaseUrl(url), url);
});

test("explicit loopback services are supported without granting remote HTTP access", () => {
  assert.equal(
    normalizeBaseUrl("http://127.0.0.1:16791/v1"),
    "http://127.0.0.1:16791/v1",
  );
  assert.equal(
    normalizeBaseUrl("http://localhost:11434/v1"),
    "http://localhost:11434/v1",
  );
  assert.equal(
    apiOriginPattern("https://models.example.test:8443/v1"),
    "https://models.example.test/*",
  );
  assert.equal(
    apiOriginPattern("http://127.0.0.1:16791/v1"),
    "http://127.0.0.1/*",
  );
});
