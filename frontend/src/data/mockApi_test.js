import test from "node:test";
import assert from "node:assert/strict";
import { adjustReleasedHours, fetchWeekSchedule, releaseHours, reserveHours, updateBookingHours } from "./mockApi.js";

test("zero-hour adjustment cancels the reservation", async () => {
  const dateKey = "2026-06-30";
  const releaseResult = await releaseHours(dateKey, 4, 4);
  const blockId = releaseResult.created[0].id;

  const reserveResult = await reserveHours(dateKey, blockId, 2, "user-1", 8);
  assert.equal(reserveResult.ok, true);

  const updateResult = await updateBookingHours(reserveResult.created.id, 0, "user-1");
  assert.equal(updateResult.ok, true);
  assert.equal(updateResult.cancelled, true);
});

test("adjustment can increase back up to available hours", async () => {
  const dateKey = "2026-06-30";
  const releaseResult = await releaseHours(dateKey, 8, 8);
  const blockId = releaseResult.created[0].id;

  const reserveResult = await reserveHours(dateKey, blockId, 8, "user-1", 8);
  assert.equal(reserveResult.ok, true);

  const reduceResult = await updateBookingHours(reserveResult.created.id, 7, "user-1");
  assert.equal(reduceResult.ok, true);

  const increaseResult = await updateBookingHours(reserveResult.created.id, 8, "user-1");
  assert.equal(increaseResult.ok, true);
  assert.equal(increaseResult.updated, true);
  assert.equal(increaseResult.booking.hours, 8);
});

test("admin can adjust a single block's hours up and down", async () => {
  const dateKey = "2026-07-01";
  const releaseResult = await releaseHours(dateKey, 6, 6, 0, "Morning Extraction", "08:00", "14:00", "Extraction");
  const blockId = releaseResult.created[0].id;

  const increased = await adjustReleasedHours(dateKey, blockId, 10, "Morning Extraction", "08:00", "14:00", "Extraction");
  assert.equal(increased.ok, true);
  assert.equal(increased.updated.totalHours, 10);

  const decreased = await adjustReleasedHours(dateKey, blockId, 6, "Morning Extraction", "08:00", "14:00", "Extraction");
  assert.equal(decreased.ok, true);
  assert.equal(decreased.updated.totalHours, 6);
});

test("adjusting one block does not affect a different project's block on the same day", async () => {
  const dateKey = "2026-07-02";
  const extraction = await releaseHours(dateKey, 8, 8, 0, "Extraction Shift", "08:00", "16:00", "Extraction", "admin-1");
  const cooking = await releaseHours(dateKey, 8, 8, 8, "Cooking Shift", "16:00", "00:00", "Cooking", "admin-1");
  const extractionBlockId = extraction.created[0].id;
  const cookingBlockId = cooking.created[0].id;

  const adjusted = await adjustReleasedHours(dateKey, extractionBlockId, 4, "Extraction Shift", "08:00", "16:00", "Extraction");
  assert.equal(adjusted.ok, true);
  assert.equal(adjusted.updated.totalHours, 4);

  const schedule = await fetchWeekSchedule([dateKey], "admin-1", true, null);
  const cookingBlockAfter = schedule[dateKey].blocks.find((b) => b.id === cookingBlockId);
  assert.ok(cookingBlockAfter, "Cooking block should still exist after adjusting the Extraction block");
  assert.equal(cookingBlockAfter.totalHours, 8);
});

test("adjustReleasedHours rejects reducing below already-claimed hours", async () => {
  const dateKey = "2026-07-03";
  const releaseResult = await releaseHours(dateKey, 8, 8, 0, "Shift", "08:00", "16:00", "Extraction");
  const blockId = releaseResult.created[0].id;
  await reserveHours(dateKey, blockId, 5, "user-1", 8);

  const blocked = await adjustReleasedHours(dateKey, blockId, 3, "Shift", "08:00", "16:00", "Extraction");
  assert.equal(blocked.ok, false);
});

test("8h/day cap applies per project, not combined", async () => {
  const dateKey = "2026-07-04";
  const extraction = await releaseHours(dateKey, 8, 8, 0, "Extraction Shift", "08:00", "16:00", "Extraction");
  const cooking = await releaseHours(dateKey, 8, 8, 8, "Cooking Shift", "16:00", "00:00", "Cooking");

  const extractionClaim = await reserveHours(dateKey, extraction.created[0].id, 8, "user-multi", 8);
  assert.equal(extractionClaim.ok, true);

  const cookingClaim = await reserveHours(dateKey, cooking.created[0].id, 8, "user-multi", 8);
  assert.equal(cookingClaim.ok, true, "should be able to claim a full 8h in a second project on the same day");
});

test("fetchWeekSchedule only returns blocks for projects the user has been granted", async () => {
  const dateKey = "2026-07-05";
  await releaseHours(dateKey, 8, 8, 0, "Extraction Shift", "08:00", "16:00", "Extraction");
  await releaseHours(dateKey, 8, 8, 8, "Cooking Shift", "16:00", "00:00", "Cooking");

  const extractionOnly = await fetchWeekSchedule([dateKey], "user-x", false, ["Extraction"]);
  assert.equal(extractionOnly[dateKey].blocks.length, 1);
  assert.equal(extractionOnly[dateKey].blocks[0].workType, "Extraction");

  const both = await fetchWeekSchedule([dateKey], "user-x", false, ["Extraction", "Cooking"]);
  assert.equal(both[dateKey].blocks.length, 2);
});

test("admin sees only their own released blocks", async () => {
  const dateKey = "2026-07-06";
  await releaseHours(dateKey, 8, 8, 0, "Admin One Shift", "08:00", "16:00", "Extraction", "admin-1");
  await releaseHours(dateKey, 8, 8, 8, "Admin Two Shift", "16:00", "00:00", "Cooking", "admin-2");

  const adminOneSchedule = await fetchWeekSchedule([dateKey], "admin-1", true, null);
  assert.equal(adminOneSchedule[dateKey].blocks.length, 1);
  assert.equal(adminOneSchedule[dateKey].blocks[0].ownerId, "admin-1");
  assert.equal(adminOneSchedule[dateKey].blocks[0].shiftName, "Admin One Shift");

  const adminTwoSchedule = await fetchWeekSchedule([dateKey], "admin-2", true, null);
  assert.equal(adminTwoSchedule[dateKey].blocks.length, 1);
  assert.equal(adminTwoSchedule[dateKey].blocks[0].ownerId, "admin-2");
  assert.equal(adminTwoSchedule[dateKey].blocks[0].shiftName, "Admin Two Shift");
});
