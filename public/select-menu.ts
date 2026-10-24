import type { ControlElement, ControlDocument, ControlWindow } from "./control-dom.js";
interface SelectOption { value: string; label: string; disabled: boolean }
export function createSelectMenu<E extends ControlElement<E> = HTMLElement>({ select, trigger, menu, value, icon, renderIcon,
  document: documentRef = globalThis.document as ControlDocument<E>, window: windowRef = globalThis.window }: { select: E & { value: string }; trigger: E; menu: E; value: E; icon?: E | undefined; renderIcon?: ((target: E, option: SelectOption) => void) | undefined; document?: ControlDocument<E> | undefined; window?: ControlWindow | undefined }) {
  let options: SelectOption[] = [], buttons: E[] = [], activeIndex = -1;
  let search = "", searchTime = 0;
  const isOpen = () => !menu.hidden;
  const enabled = (index: number) => index >= 0 && index < options.length && !options[index]!.disabled;
  const selectedIndex = () => options.findIndex((option) => option.value === select.value);

  function close() {
    menu.hidden = true;
    trigger.setAttribute("aria-expanded", "false");
    trigger.removeAttribute("aria-activedescendant");
    search = "";
  }

  function position() {
    const rect = trigger.getBoundingClientRect!();
    const height = menu.getBoundingClientRect!().height;
    const below = (windowRef?.innerHeight ?? documentRef.documentElement?.clientHeight ?? 0) - rect.bottom;
    menu.classList.toggle("opens-above", height > below - 12 && rect.top > below);
  }

  function setActive(index: number, scroll = false) {
    activeIndex = enabled(index) ? index : -1;
    buttons.forEach((button, current) => button.classList.toggle("is-active", current === activeIndex));
    if (!isOpen() || activeIndex < 0) {
      trigger.removeAttribute("aria-activedescendant");
      return;
    }
    const button = buttons[activeIndex]!;
    trigger.setAttribute("aria-activedescendant", button.id);
    if (scroll) {
      const top = button.offsetTop!, bottom = top + button.offsetHeight!;
      if (top < menu.scrollTop) menu.scrollTop = top;
      else if (bottom > menu.scrollTop + menu.clientHeight) menu.scrollTop = bottom - menu.clientHeight;
    }
  }

  function open(direction = 0) {
    if (trigger.disabled) return;
    menu.hidden = false;
    trigger.setAttribute("aria-expanded", "true");
    let index = selectedIndex();
    if (!enabled(index)) index = direction < 0 ? options.findLastIndex((option) => !option.disabled)
      : options.findIndex((option) => !option.disabled);
    setActive(index, true);
    position();
  }

  function move(direction: number) {
    if (!isOpen()) { open(direction); return; }
    let index = activeIndex;
    for (let count = 0; count < options.length; count++) {
      index = (index + direction + options.length) % options.length;
      if (enabled(index)) { setActive(index, true); return; }
    }
  }

  function choose(index: number) {
    if (select.disabled || !enabled(index)) return;
    const next = options[index]!.value;
    const changed = select.value !== next;
    if (changed) select.value = next;
    close();
    refresh();
    trigger.focus();
    if (changed) {
      const EventClass = documentRef.defaultView?.Event ?? windowRef?.Event ?? globalThis.Event;
      select.dispatchEvent(new EventClass("change", { bubbles: true }));
    }
  }

  function refresh() {
    const opened = isOpen(), scrollTop = menu.scrollTop;
    const activeValue = options[activeIndex]?.value;
    options = Array.from(select.children).filter((option) => option.tagName === "OPTION").map((option) => ({
      value: String(option.value), label: option.label || option.textContent || "", disabled: Boolean(option.disabled),
    }));
    const selected = options[selectedIndex()];
    value.textContent = selected?.label ?? "";
    if (icon) {
      icon.replaceChildren();
      if (selected && renderIcon) renderIcon(icon, selected);
    }
    trigger.disabled = Boolean(select.disabled) || !options.some((option) => !option.disabled);
    trigger.setAttribute("aria-disabled", String(trigger.disabled));
    menu.replaceChildren();
    buttons = options.map((option, index) => {
      const button = documentRef.createElement("button");
      button.type = "button";
      button.className = "select-menu-option";
      button.id = `${menu.id}-option-${index}`;
      button.tabIndex = -1;
      button.disabled = option.disabled;
      button.setAttribute("role", "option");
      button.setAttribute("aria-selected", String(option.value === select.value));
      button.setAttribute("aria-disabled", String(option.disabled));
      if (renderIcon) {
        const optionIcon = documentRef.createElement("span");
        optionIcon.className = "select-menu-option-icon";
        optionIcon.setAttribute("aria-hidden", "true");
        renderIcon(optionIcon, option);
        button.append(optionIcon);
      }
      const label = documentRef.createElement("span");
      label.className = "select-menu-option-label";
      label.textContent = option.label;
      const check = documentRef.createElement("span");
      check.className = "select-menu-option-check";
      check.setAttribute("aria-hidden", "true");
      check.textContent = "✓";
      check.hidden = option.value !== select.value;
      button.append(label, check);
      button.addEventListener("click", () => choose(index));
      button.addEventListener("mouseover", () => { if (isOpen() && enabled(index)) setActive(index); });
      menu.append(button);
      return button;
    });
    let index = opened && activeValue !== undefined ? options.findIndex((option) => option.value === activeValue) : selectedIndex();
    if (!enabled(index)) index = options.findIndex((option) => !option.disabled);
    if (trigger.disabled) close();
    setActive(index);
    if (opened && !trigger.disabled) position();
    menu.scrollTop = scrollTop;
  }

  trigger.addEventListener("click", () => { if (isOpen()) close(); else open(); });
  trigger.addEventListener("keydown", (event) => {
    if (trigger.disabled) return;
    if (event.key === "Tab") { close(); return; }
    if (event.key === "Escape") {
      if (isOpen()) { event.preventDefault(); event.stopPropagation(); close(); }
      return;
    }
    if (["ArrowDown", "ArrowUp", "Home", "End", "Enter", " "].includes(event.key!)) {
      event.preventDefault();
      if (event.key === "ArrowDown" || event.key === "ArrowUp") move(event.key === "ArrowDown" ? 1 : -1);
      else if (event.key === "Home" || event.key === "End") {
        if (!isOpen()) open();
        setActive(event.key === "Home" ? options.findIndex((option) => !option.disabled)
          : options.findLastIndex((option) => !option.disabled), true);
      } else if (isOpen()) choose(activeIndex);
      else open();
      return;
    }
    if (event.key!.length === 1 && !event.ctrlKey && !event.metaKey && !event.altKey) {
      const now = Date.now();
      search = now - searchTime > 700 ? event.key! : search + event.key;
      searchTime = now;
      if (!isOpen()) open();
      const index = options.findIndex((option) => !option.disabled && option.label.toLocaleLowerCase().startsWith(search.toLocaleLowerCase()));
      if (index >= 0) { event.preventDefault(); setActive(index, true); }
    }
  });
  menu.addEventListener("pointerdown", (event) => event.preventDefault());
  select.addEventListener("change", refresh);
  documentRef.addEventListener("pointerdown", (event) => {
    if (!trigger.contains(event.target) && !menu.contains(event.target)) close();
  });
  documentRef.addEventListener("scroll", (event) => { if (!menu.contains(event.target)) close(); }, true);
  windowRef?.addEventListener("resize", close);
  close();
  refresh();
  return { refresh, close };
}
