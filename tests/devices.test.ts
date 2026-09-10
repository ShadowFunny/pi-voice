import { test } from "node:test";
import assert from "node:assert/strict";
import { pickDeviceIndex } from "../src/devices.ts";

const MAC = ["Built-in Microphone", "Microsoft Teams Audio"];
const MAC_REVERSED = ["Microsoft Teams Audio", "Built-in Microphone"];

test("pickDeviceIndex throws a helpful error when there is no input at all", () => {
	assert.throws(() => pickDeviceIndex([], null), /No microphone found/);
});

test("pickDeviceIndex honours an explicit index", () => {
	assert.equal(pickDeviceIndex(MAC, 0), 0);
	assert.equal(pickDeviceIndex(MAC, 1), 1);
	assert.equal(pickDeviceIndex(MAC_REVERSED, 1), 1);
});

test("pickDeviceIndex rejects an out-of-range index instead of silently picking another", () => {
	assert.throws(() => pickDeviceIndex(MAC, 5), /out of range/);
	assert.throws(() => pickDeviceIndex(MAC, -1), /out of range/);
	assert.throws(() => pickDeviceIndex(MAC, 1.5), /out of range/);
	// Index 2 is invalid for a 2-device list, and the message should say how many exist.
	assert.throws(() => pickDeviceIndex(MAC, 2), /2 input/);
});

test("pickDeviceIndex auto-prefers the built-in microphone wherever it sits in the list", () => {
	assert.equal(pickDeviceIndex(MAC, null), 0);
	assert.equal(pickDeviceIndex(MAC_REVERSED, null), 1);
});

test("pickDeviceIndex prefers built-in over an external microphone", () => {
	assert.equal(pickDeviceIndex(["USB Microphone", "Built-in Microphone"], null), 1);
	assert.equal(pickDeviceIndex(["Built-in Microphone", "USB Microphone"], null), 0);
});

test("pickDeviceIndex name matching is case-insensitive", () => {
	assert.equal(pickDeviceIndex(["USB MICROPHONE", "built-in microphone"], null), 1);
});

test("pickDeviceIndex falls back through microphone-ish names then to the first device", () => {
	assert.equal(pickDeviceIndex(["Loopback Audio", "Blue Yeti Microphone"], null), 1);
	// Nothing looks like a microphone: take the first input rather than failing.
	assert.equal(pickDeviceIndex(["Loopback Audio", "Virtual Cable"], null), 0);
});

test("pickDeviceIndex does not mistake a speaker for a microphone", () => {
	// "Microphone" substring matching must not accidentally match a "Mic" speaker,
	// which is why the built-in test runs before the generic one.
	assert.equal(pickDeviceIndex(["Microphone Speaker Array"], null), 0);
});
