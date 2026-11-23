export async function selectList(control) {
  const listId = await control.getAttribute("aria-controls");
  return control.page().locator(`[id=${JSON.stringify(listId)}]`);
}

export async function selectValue(locator, value) {
  const control = locator.and(locator.page().getByRole("combobox"));
  const id = await control.getAttribute("id");
  await control.click();
  const list = await selectList(control);
  await list
    .getByRole("option")
    .and(list.locator(`[data-option-value=${JSON.stringify(value)}]`))
    .click();
  await control
    .page()
    .waitForFunction(
      ([id, value]) => document.getElementById(id)?.dataset.value === value,
      [id, value],
    );
}
