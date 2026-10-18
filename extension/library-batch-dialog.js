import { normalizeAnalysisScope } from "./analysis-scope.js";

export function createLibraryBatchDialog({ dialog, getContext, onChange, t }) {
  const scopeField = dialog.querySelector("#batch-scope-project");
  const subtree = dialog.querySelector("#batch-scope-subprojects");
  const types = dialog.querySelector("#batch-scope-types");
  const allTypes = dialog.querySelector("#batch-scope-all-types");
  const exclusions = dialog.querySelector("#batch-scope-exclusions");
  const status = dialog.querySelector("#batch-text-status");
  const tabs = [...dialog.querySelectorAll("[data-batch-kind]")];
  let scope = normalizeAnalysisScope({});
  let selectedIds = null;
  let kind = "text";
  let revision = 0;
  let locked = false;
  let rebuilding = false;
  let currentContext = { projects: [], types: [] };

  function option(value, label) {
    const node = document.createElement("option");
    node.value = value;
    node.textContent = label;
    return node;
  }

  function checkList(target, items, checkedIds) {
    const selected = new Set(checkedIds);
    target.replaceChildren(...items.map(item => {
      const label = document.createElement("label");
      const input = document.createElement("input");
      input.type = "checkbox";
      input.value = item.id;
      input.checked = selected.has(item.id);
      const name = document.createElement("span");
      name.textContent = item.name;
      label.append(input, name);
      return label;
    }));
  }

  function sync() {
    tabs.forEach(button => {
      button.setAttribute("aria-pressed", String(button.dataset.batchKind === kind));
      button.disabled = locked;
    });
    dialog.querySelector("#batch-scope-fields").disabled = locked;
    dialog.querySelector("#text-batch-content").hidden = kind !== "text";
    dialog.querySelector("#vision-batch-content").hidden = kind === "text";
    dialog.querySelector("#batch-text-status-field").hidden = kind !== "text" || rebuilding;
    subtree.closest("label").hidden = !scope.collectionId;
    const context = currentContext;
    const selectedTypes = scope.contentTypeIds?.length;
    allTypes.checked = scope.contentTypeIds === null;
    allTypes.indeterminate = Array.isArray(scope.contentTypeIds) && selectedTypes > 0;
    dialog.querySelector("#batch-scope-types-title").textContent = t("案例类型") + " · " +
      (scope.contentTypeIds === null ? t("全部") : t("已选 {count}", { count: selectedTypes }));
    dialog.querySelector("#batch-scope-exclusions-title").textContent = t("排除项目") +
      (scope.excludedCollectionIds.length ? " · " + scope.excludedCollectionIds.length : "");
    exclusions.closest("details").hidden = !context.projects.length;
    const rebuild = dialog.querySelector(".advanced-reanalysis");
    if (rebuild) rebuild.hidden = Boolean(scope.collectionId || scope.entryIds || Array.isArray(scope.contentTypeIds) || scope.excludedCollectionIds.length);
  }

  function changed() {
    revision += 1;
    sync();
    void onChange();
  }

  scopeField.addEventListener("change", () => {
    scope.collectionId = scopeField.value === ":selection" ? "" : scopeField.value;
    if (scopeField.value === ":selection") scope.entryIds = [...selectedIds];
    else delete scope.entryIds;
    changed();
  });
  subtree.addEventListener("change", () => { scope.includeSubprojects = subtree.checked; changed(); });
  types.addEventListener("change", () => {
    scope.contentTypeIds = [...types.querySelectorAll("input:checked")].map(input => input.value);
    if (scope.contentTypeIds.length === currentContext.types.length) scope.contentTypeIds = null;
    changed();
  });
  allTypes.addEventListener("change", () => {
    scope.contentTypeIds = allTypes.checked ? null : [];
    types.querySelectorAll("input").forEach(input => { input.checked = allTypes.checked; });
    changed();
  });
  exclusions.addEventListener("change", () => {
    scope.excludedCollectionIds = [...exclusions.querySelectorAll("input:checked")].map(input => input.value);
    changed();
  });
  status.addEventListener("change", changed);
  tabs.forEach(button => button.addEventListener("click", () => {
    if (kind === button.dataset.batchKind) return;
    kind = button.dataset.batchKind;
    changed();
  }));

  return {
    get kind() { return kind; },
    get revision() { return revision; },
    get scope() { return structuredClone(scope); },
    get textMode() { return status.value === "selected" ? "selected" : "incremental"; },
    get includeChanged() { return status.value !== "missing"; },
    refresh: changed,
    lock(value) { if (locked === value) return; locked = value; sync(); },
    rebuild(value) { if (rebuilding === value) return; rebuilding = value; sync(); },
    async open(options = {}) {
      const context = getContext();
      currentContext = context;
      scope = normalizeAnalysisScope(options.scope ?? { includeSubprojects: context.includeSubprojects });
      selectedIds = Array.isArray(scope.entryIds) ? [...scope.entryIds] : null;
      kind = options.kind ?? "text";
      locked = Boolean(options.locked);
      rebuilding = options.mode === "rebuild";
      status.value = options.mode === "selected" ? "selected" : options.includeChanged === true ? "incremental" : "missing";
      scopeField.replaceChildren(option("", t("全部案例")),
        ...(selectedIds ? [option(":selection", t("已选 {count} 个案例", { count: selectedIds.length }))] : []),
        ...context.projects.map(project => option(project.id, project.name)));
      scopeField.value = selectedIds ? ":selection" : scope.collectionId;
      subtree.checked = scope.includeSubprojects;
      checkList(types, context.types, scope.contentTypeIds ?? context.types.map(item => item.id));
      checkList(exclusions, context.projects, scope.excludedCollectionIds);
      types.closest("details").open = false;
      exclusions.closest("details").open = false;
      revision += 1;
      sync();
      if (!dialog.open) dialog.showModal();
      await onChange({ restoreTask: options.restoreTask });
    }
  };
}
