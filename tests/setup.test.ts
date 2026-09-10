import { test } from "node:test";
import assert from "node:assert/strict";
import { buildPipInstallArgs, buildVenvArgs, dataDir, venvDir, venvPython } from "../src/setup.ts";

test("dataDir honours XDG_DATA_HOME and falls back to ~/.local/share", () => {
	assert.equal(dataDir({ XDG_DATA_HOME: "/xdg/data" }, "/home/u"), "/xdg/data");
	assert.equal(dataDir({}, "/home/u"), "/home/u/.local/share");
});

test("dataDir treats an empty or blank variable as unset, not as a relative path", () => {
	assert.equal(dataDir({ XDG_DATA_HOME: "" }, "/home/u"), "/home/u/.local/share");
	assert.equal(dataDir({ XDG_DATA_HOME: "   " }, "/home/u"), "/home/u/.local/share");
});

test("venvDir lives under the data directory, never inside the project", () => {
	assert.equal(venvDir({}, "/home/u"), "/home/u/.local/share/pi-voice/venv");
	assert.equal(venvDir({ XDG_DATA_HOME: "/xdg" }, "/home/u"), "/xdg/pi-voice/venv");
});

test("venvPython uses Scripts on Windows and bin elsewhere", () => {
	assert.equal(venvPython("/v", "linux"), "/v/bin/python");
	assert.equal(venvPython("/v", "darwin"), "/v/bin/python");
	assert.equal(venvPython("C:\\v", "win32"), "C:\\v\\Scripts\\python.exe");
});

test("buildVenvArgs runs the venv module with the target path last", () => {
	assert.deepEqual(buildVenvArgs(["python3"], "/v"), ["-m", "venv", "/v"]);
});

test("buildVenvArgs keeps the py launcher prefix intact", () => {
	// Dropping the "-3" would leave `py -m venv`, which picks whatever Python py defaults to.
	assert.deepEqual(buildVenvArgs(["py", "-3"], "C:\\v"), ["-3", "-m", "venv", "C:\\v"]);
});

test("buildPipInstallArgs installs into the given interpreter", () => {
	assert.deepEqual(buildPipInstallArgs(["/v/bin/python"], ["faster-whisper"]), [
		"-m", "pip", "install", "--disable-pip-version-check", "faster-whisper",
	]);
});

test("buildPipInstallArgs keeps the py launcher prefix intact", () => {
	assert.deepEqual(buildPipInstallArgs(["py", "-3"], ["faster-whisper"]), [
		"-3", "-m", "pip", "install", "--disable-pip-version-check", "faster-whisper",
	]);
});
