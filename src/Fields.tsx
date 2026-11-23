import { tr, useLanguage } from "./i18n";
import type { FormField } from "../shared/types";
import { api, attempt } from "./store";
import { CustomSelect } from "./CustomSelect";
export type Answers = Record<string, string | number | boolean | string[]>;
export function defaults(fields: FormField[]): Answers {
  return Object.fromEntries(
    fields
      .filter((f) => f.default !== undefined)
      .map((f) => [f.key, f.default]),
  ) as Answers;
}
export function Fields({
  fields,
  values,
  change,
}: {
  fields: FormField[];
  values: Answers;
  change: (values: Answers) => void;
}) {
  useLanguage();

  return (
    <>
      {fields
        .filter(
          (field) =>
            !field.hidden &&
            (!field.when ||
              field.when.every((condition) =>
                condition.op === "eq"
                  ? values[condition.key] === condition.value
                  : values[condition.key] !== condition.value,
              )),
        )
        .map((field) => {
          const hasSelect =
            field.type === "multiselect" ||
            (field.type !== "external" &&
              field.type !== "boolean" &&
              !!field.options);
          const Field = hasSelect ? "div" : "label";
          return (
            <Field className="field" key={field.key}>
              <span>
                {field.title ?? field.key}
                {field.required ? " *" : ""}
              </span>
              {field.type === "external" ? (
                <button
                  type="button"
                  className="secondary"
                  onClick={() =>
                    void attempt(() => api.openExternal(field.url!))
                  }
                >
                  {tr("Открыть страницу")}
                </button>
              ) : field.type === "boolean" ? (
                <input
                  type="checkbox"
                  checked={!!values[field.key]}
                  onChange={(e) =>
                    change({ ...values, [field.key]: e.target.checked })
                  }
                />
              ) : field.type === "multiselect" ? (
                <CustomSelect
                  multiple
                  aria-label={field.title ?? field.key}
                  value={(values[field.key] as string[]) ?? []}
                  onChange={(value) =>
                    change({ ...values, [field.key]: value })
                  }
                  options={field.options ?? []}
                  placeholder={tr("Выберите…")}
                />
              ) : field.options ? (
                <CustomSelect
                  aria-label={field.title ?? field.key}
                  required={field.required}
                  value={String(values[field.key] ?? "")}
                  onChange={(value) =>
                    change({ ...values, [field.key]: value })
                  }
                  options={[
                    { value: "", label: tr("Выберите…") },
                    ...field.options,
                  ]}
                />
              ) : (
                <input
                  required={field.required}
                  type={
                    field.type === "number" || field.type === "integer"
                      ? "number"
                      : "text"
                  }
                  step={field.type === "integer" ? 1 : "any"}
                  value={String(values[field.key] ?? "")}
                  onChange={(e) =>
                    change({
                      ...values,
                      [field.key]:
                        field.type === "number" || field.type === "integer"
                          ? Number(e.target.value)
                          : e.target.value,
                    })
                  }
                />
              )}{" "}
              {field.description && <small>{field.description}</small>}
            </Field>
          );
        })}
    </>
  );
}
