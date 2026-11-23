export async function revealActivity(stage, kind) {
  const summary = stage.locator(".activity-stage-toggle").first();
  if ((await summary.getAttribute("aria-expanded")) === "false")
    await summary.click();
  const group = stage
    .locator(`.activity-category[data-kind="${kind}"] > button`)
    .first();
  if (
    (await group.count()) &&
    (await group.getAttribute("aria-expanded")) === "false"
  )
    await group.click();
}

export async function revealTaskDiff(page) {
  const summary = page.locator(".task-files-toggle");
  if ((await summary.getAttribute("aria-expanded")) === "false")
    await summary.click();
}
