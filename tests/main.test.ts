import customScript from "../src/main";

test("main default export is the custom script", () => {
  expect(customScript).not.toBeUndefined();
  expect(customScript.run).not.toBeUndefined();
  expect(customScript.getScriptManifest).not.toBeUndefined();
  expect(customScript.getDefaultParameters).not.toBeUndefined();
});

test("getScriptManifest reports a Firebot 5 startup-only script", async () => {
  const manifest = await customScript.getScriptManifest!();
  expect(manifest.firebotVersion).toBe("5");
  expect(manifest.startupOnly).toBe(true);
});

test("getDefaultParameters exposes the Meld connection defaults", async () => {
  const params = await customScript.getDefaultParameters!();
  expect(params.ipAddress.default).toBe("127.0.0.1");
  expect(params.port.default).toBe(13376);
});
