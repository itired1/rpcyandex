'use strict';

/**
 * Settings window renderer.
 *
 * Builds the whole form from `schema.js`, so adding a setting is a one-line
 * change there. Writes go straight through to the mod's settings store, which
 * already applies changes live via its file watcher — no Save button, and no way
 * to leave the form and the real configuration out of sync.
 */

const api = window.itirpcSettings;
const { SECTIONS, FIELD_TYPES } = window.itirpcSchema;
const { toAccelerator, describeAccelerator } = window.itirpcAccelerator;

const elements = {
  nav: document.getElementById('nav'),
  content: document.getElementById('content'),
  version: document.getElementById('version'),
  saved: document.getElementById('saved'),
  openConfig: document.getElementById('open-config'),
  openLogs: document.getElementById('open-logs'),
};

/** Latest snapshot from the main process. */
let state = { settings: {}, status: {}, problems: [] };
let activeSection = SECTIONS[0].id;
/** The hotkey field currently capturing a combination, if any. */
let capturing = null;

// --- helpers ---------------------------------------------------------------

function valueAt(path) {
  return path.split('.').reduce((acc, key) => (acc && typeof acc === 'object' ? acc[key] : undefined), state.settings);
}

function setAt(path, value) {
  const keys = path.split('.');
  const last = keys.pop();
  let cursor = state.settings;
  for (const key of keys) {
    if (typeof cursor[key] !== 'object' || cursor[key] === null) cursor[key] = {};
    cursor = cursor[key];
  }
  cursor[last] = value;
}

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

/** Brief confirmation that a write landed. */
let savedTimer = null;
function flashSaved() {
  elements.saved.hidden = false;
  if (savedTimer) clearTimeout(savedTimer);
  savedTimer = setTimeout(() => {
    elements.saved.hidden = true;
  }, 1200);
}

async function write(path, value) {
  const result = await api.set(path, value);
  if (!result?.ok) {
    // Re-read so the control cannot keep showing a value that was rejected.
    await load();
    return;
  }
  setAt(path, value);
  flashSaved();
}

// --- control construction --------------------------------------------------

function buildControl(field) {
  const wrap = el('div', 'field-control');

  switch (field.type) {
    case FIELD_TYPES.BOOLEAN: {
      const label = el('label', 'switch');
      const input = document.createElement('input');
      input.type = 'checkbox';
      input.checked = Boolean(valueAt(field.path));
      input.addEventListener('change', () => write(field.path, input.checked));
      label.append(input, el('span', null, input.checked ? 'включено' : 'выключено'));
      input.addEventListener('change', () => {
        label.lastChild.textContent = input.checked ? 'включено' : 'выключено';
      });
      wrap.append(label);
      return wrap;
    }

    case FIELD_TYPES.SELECT: {
      const select = document.createElement('select');
      for (const option of field.options) {
        const node = document.createElement('option');
        node.value = String(option.value);
        node.textContent = option.label;
        select.append(node);
      }
      const current = valueAt(field.path);
      select.value = String(current);
      // A value that is not in the list (hand-edited config) must still show.
      if (select.value !== String(current)) {
        const node = document.createElement('option');
        node.value = String(current);
        node.textContent = `${current} (не из списка)`;
        select.append(node);
        select.value = String(current);
      }
      select.addEventListener('change', () => {
        const option = field.options.find((o) => String(o.value) === select.value);
        write(field.path, option ? option.value : select.value);
      });
      wrap.append(select);
      return wrap;
    }

    case FIELD_TYPES.NUMBER: {
      const min = field.min ?? 0;
      const max = field.max ?? 1000;
      const step = field.step ?? 1;

      const input = document.createElement('input');
      input.type = 'number';
      input.min = String(min);
      input.max = String(max);
      input.step = String(step);

      const slider = document.createElement('input');
      slider.type = 'range';
      slider.min = String(min);
      slider.max = String(max);
      slider.step = String(step);

      const current = Number(valueAt(field.path));
      input.value = String(Number.isFinite(current) ? current : min);
      slider.value = input.value;

      const commit = (raw) => {
        const parsed = Number(raw);
        if (!Number.isFinite(parsed)) return;
        const clamped = Math.min(max, Math.max(min, parsed));
        // Zoom is a factor with fractions; everything else is a whole number.
        const value = step < 1 ? Math.round(clamped * 1000) / 1000 : Math.round(clamped);
        input.value = String(value);
        slider.value = String(value);
        write(field.path, value);
      };

      input.addEventListener('change', () => commit(input.value));
      slider.addEventListener('input', () => {
        input.value = slider.value;
      });
      slider.addEventListener('change', () => commit(slider.value));

      wrap.append(input, slider);
      return wrap;
    }

    case FIELD_TYPES.SECRET:
    case FIELD_TYPES.TEXT: {
      const input = document.createElement('input');
      input.type = field.type === FIELD_TYPES.SECRET ? 'password' : 'text';
      if (field.placeholder) input.placeholder = field.placeholder;
      input.value = valueAt(field.path) ?? '';
      input.addEventListener('change', () => write(field.path, input.value.trim()));

      if (field.type === FIELD_TYPES.SECRET) {
        const toggle = el('button', 'button', 'Показать');
        toggle.type = 'button';
        toggle.addEventListener('click', () => {
          const hidden = input.type === 'password';
          input.type = hidden ? 'text' : 'password';
          toggle.textContent = hidden ? 'Скрыть' : 'Показать';
        });
        wrap.append(input, toggle);
      } else {
        wrap.append(input);
      }
      return wrap;
    }

    case FIELD_TYPES.HOTKEY: {
      const button = el('button', 'hotkey', describeAccelerator(valueAt(field.path)));
      button.type = 'button';
      button.dataset.path = field.path;

      const state = state.hotkeyStates?.[field.path.split('.').pop()];
      if (state === false) button.dataset.state = 'taken';
      if (state === null) button.dataset.state = 'inactive';

      const hint = el('span', 'badge');
      if (state === true) {
        hint.textContent = 'работает';
        hint.dataset.tone = 'ok';
      } else if (state === false) {
        hint.textContent = 'занято другой программой';
        hint.dataset.tone = 'warn';
      } else {
        hint.textContent = 'выключено';
      }

      const clear = el('button', 'button', 'Сбросить');
      clear.type = 'button';
      clear.addEventListener('click', async () => {
        await write(field.path, 'none');
        button.textContent = describeAccelerator('none');
      });

      button.addEventListener('click', () => startCapture(button, field.path));
      button.addEventListener('blur', () => stopCapture(button, false));

      wrap.append(button, hint, clear);
      return wrap;
    }

    case FIELD_TYPES.DIRECTORY: {
      const input = document.createElement('input');
      input.type = 'text';
      input.value = valueAt(field.path) ?? '';
      input.placeholder = field.placeholder ?? '';
      input.addEventListener('change', () => write(field.path, input.value.trim()));

      const browse = el('button', 'button', 'Обзор…');
      browse.type = 'button';
      browse.addEventListener('click', async () => {
        const chosen = await api.pickDirectory(input.value);
        if (chosen) {
          input.value = chosen;
          write(field.path, chosen);
        }
      });

      wrap.append(input, browse);
      return wrap;
    }

    case FIELD_TYPES.READONLY: {
      // A computed description when the field names a source, otherwise the
      // stored value shown as-is (for settings that exist but are not editable).
      if (field.source === 'lastfmStatus') {
        wrap.append(el('div', 'value-readonly', describeLastFm()));
      } else if (field.source) {
        wrap.append(el('div', 'value-readonly', describeCacheDirectory()));
      } else {
        const raw = valueAt(field.path);
        wrap.append(el('div', 'value-readonly', raw ? String(raw) : 'путь по умолчанию'));
      }
      return wrap;
    }

    case FIELD_TYPES.ACTION: {
      for (const action of actionsFor(field.source)) {
        const button = el('button', 'button', action.label);
        button.type = 'button';
        if (action.tone) button.dataset.tone = action.tone;
        button.addEventListener('click', async () => {
          const result = await api.action(action.name);
          if (result?.message) await load();
          else await load();
        });
        wrap.append(button);
      }
      return wrap;
    }

    default:
      wrap.append(el('span', 'value-readonly', `неизвестный тип поля: ${field.type}`));
      return wrap;
  }
}

function describeLastFm() {
  const status = state.status?.lastfm;
  if (!status) return 'модуль недоступен';
  if (!status.configured) return 'не заданы API key и shared secret';
  if (!status.authenticated) return 'ключи заданы, вход не выполнен';
  return `выполнен вход: ${status.username ?? 'пользователь'}`;
}

function describeCacheDirectory() {
  return state.status?.cacheDirectory ?? 'путь по умолчанию';
}

/** Buttons for an ACTION field, as a function of the current status. */
function actionsFor(source) {
  const lastfm = state.status?.lastfm;

  switch (source) {
    case 'lastfmAccount':
      return lastfm?.authenticated
        ? [{ name: 'lastfm-signout', label: 'Выйти из Last.fm' }]
        : [{ name: 'lastfm-authorize', label: 'Авторизоваться в Last.fm' }];
    case 'miniPlayerOpen':
      return [{ name: 'miniplayer-open', label: 'Открыть мини-плеер' }];
    case 'folders':
      return [
        { name: 'open-config', label: 'Открыть config.json' },
        { name: 'open-logs', label: 'Открыть логи' },
        { name: 'open-downloads', label: 'Открыть папку загрузок' },
      ];
    default:
      return [];
  }
}

// --- hotkey capture --------------------------------------------------------

function startCapture(button, path) {
  if (capturing && capturing.button !== button) stopCapture(capturing.button, false);
  capturing = { button, path };
  button.dataset.capturing = 'true';
  button.textContent = 'Нажмите комбинацию…';
  button.focus();
  window.addEventListener('keydown', onCaptureKey, true);
}

function stopCapture(button, restore) {
  if (!capturing || capturing.button !== button) return;
  window.removeEventListener('keydown', onCaptureKey, true);
  delete button.dataset.capturing;
  if (restore) button.textContent = describeAccelerator(valueAt(capturing.path));
  capturing = null;
}

function onCaptureKey(event) {
  if (!capturing) return;
  event.preventDefault();
  event.stopPropagation();

  if (event.key === 'Escape') {
    const { button, path } = capturing;
    stopCapture(button, false);
    button.textContent = describeAccelerator(valueAt(path));
    return;
  }

  const accelerator = toAccelerator(event);
  if (!accelerator) return; // a lone modifier or an unusable key: keep waiting

  const { button, path } = capturing;
  stopCapture(button, false);
  button.textContent = describeAccelerator(accelerator);
  write(path, accelerator);
}

// --- rendering -------------------------------------------------------------

function renderNav() {
  elements.nav.replaceChildren();
  for (const section of SECTIONS) {
    const button = el('button', 'nav-item', section.title);
    button.type = 'button';
    button.setAttribute('aria-current', String(section.id === activeSection));
    button.addEventListener('click', () => {
      activeSection = section.id;
      renderNav();
      renderSection();
    });
    elements.nav.append(button);
  }
}

function renderSection() {
  const section = SECTIONS.find((s) => s.id === activeSection) ?? SECTIONS[0];
  elements.content.replaceChildren();

  elements.content.append(el('h1', 'section-title', section.title));
  if (section.description) elements.content.append(el('p', 'section-description', section.description));

  if (state.problems?.length) {
    const box = el('div', 'problems');
    box.append(el('strong', null, 'Замечания:'));
    const list = el('ul');
    for (const problem of state.problems) list.append(el('li', null, problem));
    box.append(list);
    elements.content.append(box);
  }

  for (const field of section.fields) {
    const row = el('div', 'field');
    row.append(el('div', 'field-label', field.label));
    row.append(buildControl(field));
    if (field.help) row.append(el('div', 'field-help', field.help));
    elements.content.append(row);
  }
}

// --- lifecycle -------------------------------------------------------------

async function load() {
  const snapshot = await api.getAll();
  if (!snapshot) return;
  state = snapshot;
  elements.version.textContent = snapshot.version ? `v${snapshot.version}` : '';
  renderSection();
}

elements.openConfig.addEventListener('click', () => api.action('open-config'));
elements.openLogs.addEventListener('click', () => api.action('open-logs'));

api.onStatus((status) => {
  state.status = status.status ?? state.status;
  state.problems = status.problems ?? state.problems;
  state.hotkeyStates = status.hotkeyStates ?? state.hotkeyStates;
  renderSection();
});

renderNav();
load();
api.ready();
