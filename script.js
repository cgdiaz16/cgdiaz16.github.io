'use strict';

/* =============================================================================
   THE GUTTER — script
   -----------------------------------------------------------------------------
   Plain JavaScript, no framework, no build step. There's no virtual DOM
   doing diffing for us, so the rules here are explicit:
     - `widgets` is the one source of truth (a plain array of objects).
     - Any function that changes it calls render() afterward, by hand.
     - render() does NOT throw away and rebuild the DOM each time — it
       keeps one real DOM node per widget (in `panelNodes`) and only
       updates that node's inline styles/text. That's what lets the CSS
       transition animate a swap; destroying and recreating an element
       would skip the animation entirely.

   FILE MAP (top to bottom):
     1. GRID CONSTANTS + HELPERS   — (col,row) <-> pixels, same math as before
     2. ICONS                      — tiny inline SVGs, so this has zero
                                      external dependencies besides the
                                      masthead font
     3. WIDGET_TYPES registry      — type string -> icon/content/default size
     4. PANEL NODE                 — builds one article's DOM + drag/resize
     5. APP STATE + RENDER LOOP    — the widgets array and everything that
                                      mutates it
     6. INIT                       — wires up the static "+ ADD ARTICLE"
                                      button/menu and renders for the first time

   HOW TO ADD A NEW WIDGET TYPE LATER:
     a) Write a createContent(widget, onUpdate) function that returns
        { element, destroy }.
     b) Add one entry to WIDGET_TYPES below pointing at it, with an icon
        and a defaultSpan.
     Dragging, resizing, swapping, and numbering all just work automatically.
   ============================================================================= */


/* -----------------------------------------------------------------------------
   1. GRID CONSTANTS + HELPERS
   Every panel lives at an integer (col, row) and spans (colSpan x rowSpan)
   cells — never a fractional pixel position. GAP is the literal "gutter":
   the visible gap between panels IS this constant.
----------------------------------------------------------------------------- */
const CELL_W = 92;    // width of one grid cell, in pixels
const CELL_H = 67;    // height of one grid cell, in pixels
const GAP = 16;        // the gutter: space between cells, in pixels
let GRID_COLS = 20;  // how many columns the board has (recalculated to fill viewport)
let GRID_ROWS = 16;  // how many rows the board has (recalculated to fill viewport)

const CELL_INSET = GAP / 2;
const colToX = (col) => (col - 1) * (CELL_W + GAP) + CELL_INSET;
const rowToY = (row) => (row - 1) * (CELL_H + GAP) + CELL_INSET;
const spanToW = (span) => span * CELL_W + (span - 1) * GAP;
const spanToH = (span) => span * CELL_H + (span - 1) * GAP;
const xToCol = (x) => Math.round(x / (CELL_W + GAP)) + 1;
const yToRow = (y) => Math.round(y / (CELL_H + GAP)) + 1;
const clamp = (n, min, max) => Math.min(Math.max(n, min), max);

function rectsOverlap(aCol, aRow, aColSpan, aRowSpan, bCol, bRow, bColSpan, bRowSpan) {
  const aColEnd = aCol + aColSpan - 1;
  const aRowEnd = aRow + aRowSpan - 1;
  const bColEnd = bCol + bColSpan - 1;
  const bRowEnd = bRow + bRowSpan - 1;
  return aCol <= bColEnd && aColEnd >= bCol && aRow <= bRowEnd && aRowEnd >= bRow;
}

function getViewportCenterCell() {
  const layerX = (window.innerWidth / 2 - panX) / zoom - CELL_INSET;
  const layerY = (window.innerHeight / 2 - panY) / zoom - CELL_INSET;
  const col = Math.round(layerX / (CELL_W + GAP)) + 1;
  const row = Math.round(layerY / (CELL_H + GAP)) + 1;
  return { col, row };
}

function findFreeSlot(currentWidgets, colSpan, rowSpan) {
  const center = getViewportCenterCell();
  const centerCol = center.col - Math.floor(colSpan / 2);
  const centerRow = center.row - Math.floor(rowSpan / 2);

  const maxRadius = Math.max(GRID_COLS, GRID_ROWS);
  for (let r = 0; r <= maxRadius; r++) {
    for (let dr = -r; dr <= r; dr++) {
      for (let dc = -r; dc <= r; dc++) {
        if (Math.abs(dr) !== r && Math.abs(dc) !== r) continue;
        const col = centerCol + dc;
        const row = centerRow + dr;
        const collides = currentWidgets.some((w) =>
          rectsOverlap(col, row, colSpan, rowSpan, w.col, w.row, w.colSpan, w.rowSpan)
        );
        if (!collides) return { col, row };
      }
    }
  }
  return { col: centerCol, row: centerRow };
}


/* -----------------------------------------------------------------------------
   2. ICONS
   Small inline SVGs (stroke="currentColor" so they pick up the ink color
   automatically) — kept tiny and local instead of pulling in an icon
   library, so this whole app has no dependency beyond the masthead font.
----------------------------------------------------------------------------- */
const ICONS = {
  clock:
    '<svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="9"></circle><polyline points="12 7 12 12 15 14"></polyline></svg>',
  note:
    '<svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M5 3h11l3 3v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2z"></path><path d="M16 3v5h5"></path></svg>',
  calendar:
    '<svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="4" width="18" height="18" rx="2"></rect><line x1="16" y1="2" x2="16" y2="6"></line><line x1="8" y1="2" x2="8" y2="6"></line><line x1="3" y1="10" x2="21" y2="10"></line></svg>',
  notebook:
    '<svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M4 19V5a2 2 0 0 1 2-2h12a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2z"></path><line x1="8" y1="3" x2="8" y2="21"></line><line x1="12" y1="8" x2="17" y2="8"></line><line x1="12" y1="12" x2="17" y2="12"></line></svg>',
  todo:
    '<svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M9 11l3 3L22 4"></path><path d="M21 12v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11"></path></svg>',
  reddit:
    '<svg viewBox="0 0 24 24" width="13" height="13" fill="currentColor"><path d="M12 0A12 12 0 0 0 0 12a12 12 0 0 0 12 12 12 12 0 0 0 12-12A12 12 0 0 0 12 0zm5.01 4.744c.688 0 1.25.561 1.25 1.249a1.25 1.25 0 0 1-2.498.056l-2.597-.547-.8 3.747c1.824.07 3.48.632 4.674 1.488.308-.309.73-.491 1.207-.491.968 0 1.754.786 1.754 1.754 0 .716-.435 1.333-1.01 1.614a3.111 3.111 0 0 1 .042.52c0 2.694-3.13 4.87-7.004 4.87-3.874 0-7.004-2.176-7.004-4.87 0-.183.015-.366.043-.534A1.748 1.748 0 0 1 4.028 12c0-.968.786-1.754 1.754-1.754.463 0 .898.196 1.207.49 1.207-.883 2.878-1.43 4.744-1.487l.885-4.182a.342.342 0 0 1 .14-.197.35.35 0 0 1 .238-.042l2.906.617a1.214 1.214 0 0 1 1.108-.701zM9.25 12C8.561 12 8 12.562 8 13.25c0 .687.561 1.248 1.25 1.248.687 0 1.248-.561 1.248-1.249 0-.688-.561-1.249-1.249-1.249zm5.5 0c-.687 0-1.248.561-1.248 1.25 0 .687.561 1.248 1.249 1.248.688 0 1.249-.561 1.249-1.249 0-.687-.562-1.249-1.25-1.249zm-5.466 3.99a.327.327 0 0 0-.231.094.33.33 0 0 0 0 .463c.842.842 2.484.913 2.961.913.477 0 2.105-.056 2.961-.913a.361.361 0 0 0 0-.463.327.327 0 0 0-.462 0c-.53.53-1.645.73-2.5.73-.852 0-1.983-.2-2.498-.73a.327.327 0 0 0-.231-.094z"/></svg>',
};


/* -----------------------------------------------------------------------------
   3. WIDGET_TYPES REGISTRY
   The single source of truth connecting a widget's "type" string to its
   label/icon, how it's built, and how many grid cells it starts at.
   createContent() gets the live widget object plus an onUpdate(partial)
   callback, and must return { element, destroy }. `destroy` is this
   widget's chance to clean up (e.g. stop a setInterval) when it's removed
   from the board — the equivalent of a React useEffect cleanup function.
----------------------------------------------------------------------------- */
const WIDGET_TYPES = {
  clock: {
    label: 'Clock',
    icon: ICONS.clock,
    defaultSpan: { colSpan: 2, rowSpan: 2 },
    createContent() {
      // A simple live clock. It doesn't read or write the shared widget
      // object — "what time is it" isn't data worth saving.
      const el = document.createElement('div');
      el.className = 'gutter-clock';
      const timeEl = document.createElement('div');
      timeEl.className = 'gutter-clock-time';
      const dateEl = document.createElement('div');
      dateEl.className = 'gutter-clock-date';
      el.append(timeEl, dateEl);

      function tick() {
        const now = new Date();
        timeEl.textContent = now.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
        dateEl.textContent = now.toLocaleDateString([], { weekday: 'short', month: 'short', day: 'numeric' });
      }
      tick();
      const intervalId = setInterval(tick, 1000);

      return {
        element: el,
        destroy() { clearInterval(intervalId); }, // stop ticking once this article is removed
      };
    },
  },
  note: {
    label: 'Note',
    icon: ICONS.note,
    defaultSpan: { colSpan: 4, rowSpan: 4 },
    createContent(widget, onUpdate) {
      // UNLIKE the clock, a note's content is worth saving, so it lives on
      // the widget object itself (widget.content) and round-trips through
      // onUpdate, same as every other field a widget might want to persist.
      const textarea = document.createElement('textarea');
      textarea.className = 'gutter-note';
      textarea.placeholder = 'Write something here...';
      textarea.value = widget.content || '';
      textarea.addEventListener('input', () => onUpdate({ content: textarea.value }));
      // stop the drag handler on the header from firing when selecting text
      textarea.addEventListener('pointerdown', (e) => e.stopPropagation());
      return { element: textarea, destroy() {} };
    },
  },
  notebook: {
    label: 'Notebook',
    icon: ICONS.notebook,
    defaultSpan: { colSpan: 6, rowSpan: 6 },
    createContent(widget, onUpdate) {
      const el = document.createElement('div');
      el.className = 'gutter-notebook';

      if (!widget.notes) widget.notes = [];
      let noteIdCounter = widget.notes.reduce((max, n) => Math.max(max, n.id), 0);
      let topNoteZ = widget.notes.reduce((max, n) => Math.max(max, n.z || 0), 0);
      const selectedNoteIds = new Set();
      const noteCards = new Map();

      const addNoteBtn = document.createElement('button');
      addNoteBtn.type = 'button';
      addNoteBtn.className = 'gutter-notebook-add';
      addNoteBtn.textContent = '+ Add Note';
      addNoteBtn.addEventListener('pointerdown', (e) => e.stopPropagation());
      addNoteBtn.addEventListener('click', () => {
        const id = ++noteIdCounter;
        topNoteZ++;
        const note = { id, x: 10 + Math.random() * 40, y: 10 + Math.random() * 40, w: 140, h: 100, z: topNoteZ, text: '' };
        widget.notes.push(note);
        onUpdate({ notes: widget.notes });
        renderNotes();
      });

      const canvas = document.createElement('div');
      canvas.className = 'gutter-notebook-canvas';
      el.append(addNoteBtn, canvas);

      function applySelection() {
        for (const [id, card] of noteCards) {
          card.classList.toggle('is-selected', selectedNoteIds.has(id));
        }
      }

      function renderNotes() {
        canvas.innerHTML = '';
        noteCards.clear();
        for (const note of widget.notes) {
          const card = buildMiniNote(note);
          noteCards.set(note.id, card);
          canvas.appendChild(card);
        }
        applySelection();
      }

      function buildMiniNote(note) {
        const card = document.createElement('div');
        card.className = 'gutter-mini-note';
        card.style.left = note.x + 'px';
        card.style.top = note.y + 'px';
        card.style.width = note.w + 'px';
        card.style.height = note.h + 'px';
        card.style.zIndex = note.z;

        card.addEventListener('pointerdown', (e) => {
          if (!e.target.closest('.gutter-mini-note-handle')) return;
          if (!selectedNoteIds.has(note.id)) {
            selectedNoteIds.clear();
            applySelection();
          }
        });

        const handle = document.createElement('div');
        handle.className = 'gutter-mini-note-handle';

        const removeBtn = document.createElement('button');
        removeBtn.type = 'button';
        removeBtn.className = 'gutter-mini-note-remove';
        removeBtn.innerHTML = '&times;';
        removeBtn.addEventListener('pointerdown', (e) => e.stopPropagation());
        removeBtn.addEventListener('click', () => {
          widget.notes = widget.notes.filter((n) => n.id !== note.id);
          selectedNoteIds.delete(note.id);
          onUpdate({ notes: widget.notes });
          renderNotes();
        });
        handle.appendChild(removeBtn);

        const textarea = document.createElement('textarea');
        textarea.className = 'gutter-mini-note-text';
        textarea.value = note.text || '';
        textarea.placeholder = 'Note...';
        textarea.addEventListener('pointerdown', (e) => e.stopPropagation());
        textarea.addEventListener('input', () => {
          note.text = textarea.value;
          onUpdate({ notes: widget.notes });
        });

        const resizeHandle = document.createElement('div');
        resizeHandle.className = 'gutter-mini-note-resize';

        card.append(handle, textarea, resizeHandle);

        handle.addEventListener('pointerdown', (e) => {
          e.stopPropagation();
          topNoteZ++;
          note.z = topNoteZ;
          card.style.zIndex = note.z;

          const isGroupDrag = selectedNoteIds.has(note.id) && selectedNoteIds.size > 1;
          const dragIds = isGroupDrag ? [...selectedNoteIds] : [note.id];

          const snapshots = dragIds.map((id) => {
            const n = widget.notes.find((nn) => nn.id === id);
            return { note: n, origX: n.x, origY: n.y, card: noteCards.get(id) };
          });

          const startX = e.clientX;
          const startY = e.clientY;

          for (const s of snapshots) {
            if (s.card) s.card.style.transition = 'none';
          }

          function move(ev) {
            const dx = ev.clientX - startX;
            const dy = ev.clientY - startY;
            for (const s of snapshots) {
              s.note.x = Math.max(0, s.origX + dx);
              s.note.y = Math.max(0, s.origY + dy);
              if (s.card) {
                s.card.style.left = s.note.x + 'px';
                s.card.style.top = s.note.y + 'px';
              }
            }
          }
          function up() {
            for (const s of snapshots) {
              if (s.card) s.card.style.transition = '';
            }
            onUpdate({ notes: widget.notes });
            window.removeEventListener('pointermove', move);
            window.removeEventListener('pointerup', up);
          }
          window.addEventListener('pointermove', move);
          window.addEventListener('pointerup', up);
        });

        resizeHandle.addEventListener('pointerdown', (e) => {
          e.stopPropagation();
          const startX = e.clientX;
          const startY = e.clientY;
          const origW = note.w;
          const origH = note.h;

          function move(ev) {
            note.w = Math.max(80, origW + ev.clientX - startX);
            note.h = Math.max(50, origH + ev.clientY - startY);
            card.style.width = note.w + 'px';
            card.style.height = note.h + 'px';
          }
          function up() {
            onUpdate({ notes: widget.notes });
            window.removeEventListener('pointermove', move);
            window.removeEventListener('pointerup', up);
          }
          window.addEventListener('pointermove', move);
          window.addEventListener('pointerup', up);
        });

        return card;
      }

      // Marquee selection on empty notebook canvas
      canvas.addEventListener('pointerdown', (e) => {
        if (e.target !== canvas) return;
        e.stopPropagation();

        selectedNoteIds.clear();
        applySelection();

        const rect = canvas.getBoundingClientRect();
        const originX = e.clientX - rect.left + canvas.scrollLeft;
        const originY = e.clientY - rect.top + canvas.scrollTop;

        const marquee = document.createElement('div');
        marquee.className = 'gutter-notebook-marquee';
        canvas.appendChild(marquee);

        function handleMove(ev) {
          const curX = ev.clientX - rect.left + canvas.scrollLeft;
          const curY = ev.clientY - rect.top + canvas.scrollTop;
          const left = Math.min(originX, curX);
          const top = Math.min(originY, curY);
          const width = Math.abs(curX - originX);
          const height = Math.abs(curY - originY);

          marquee.style.left = left + 'px';
          marquee.style.top = top + 'px';
          marquee.style.width = width + 'px';
          marquee.style.height = height + 'px';

          selectedNoteIds.clear();
          for (const n of widget.notes) {
            const nRight = n.x + n.w;
            const nBottom = n.y + n.h;
            if (left < nRight && left + width > n.x && top < nBottom && top + height > n.y) {
              selectedNoteIds.add(n.id);
            }
          }
          applySelection();
        }

        function handleUp() {
          marquee.remove();
          window.removeEventListener('pointermove', handleMove);
          window.removeEventListener('pointerup', handleUp);
        }

        window.addEventListener('pointermove', handleMove);
        window.addEventListener('pointerup', handleUp);
      });

      renderNotes();
      return { element: el, destroy() {} };
    },
  },
  calendar: {
    label: 'Calendar',
    icon: ICONS.calendar,
    defaultSpan: { colSpan: 4, rowSpan: 4 },
    createContent(widget) {
      const el = document.createElement('div');
      el.className = 'gutter-calendar';

      let viewing = new Date();

      function buildMonth() {
        const year = viewing.getFullYear();
        const month = viewing.getMonth();
        const today = new Date();
        const first = new Date(year, month, 1);
        const lastDay = new Date(year, month + 1, 0).getDate();
        const startDow = first.getDay();

        const monthName = viewing.toLocaleDateString([], { month: 'long', year: 'numeric' });

        let html = '<div class="gutter-cal-nav">'
          + '<button type="button" class="gutter-cal-prev">&lsaquo;</button>'
          + '<span class="gutter-cal-month">' + monthName + '</span>'
          + '<button type="button" class="gutter-cal-next">&rsaquo;</button>'
          + '</div>';

        html += '<div class="gutter-cal-grid">';
        const days = ['Su','Mo','Tu','We','Th','Fr','Sa'];
        for (const d of days) html += '<span class="gutter-cal-dow">' + d + '</span>';

        for (let i = 0; i < startDow; i++) html += '<span></span>';
        for (let d = 1; d <= lastDay; d++) {
          const isToday = d === today.getDate() && month === today.getMonth() && year === today.getFullYear();
          html += '<span class="gutter-cal-day' + (isToday ? ' is-today' : '') + '">' + d + '</span>';
        }
        html += '</div>';

        el.innerHTML = html;
        el.querySelector('.gutter-cal-prev').addEventListener('pointerdown', (e) => e.stopPropagation());
        el.querySelector('.gutter-cal-next').addEventListener('pointerdown', (e) => e.stopPropagation());
        el.querySelector('.gutter-cal-prev').addEventListener('click', () => {
          viewing = new Date(viewing.getFullYear(), viewing.getMonth() - 1, 1);
          buildMonth();
        });
        el.querySelector('.gutter-cal-next').addEventListener('click', () => {
          viewing = new Date(viewing.getFullYear(), viewing.getMonth() + 1, 1);
          buildMonth();
        });
      }

      buildMonth();
      return { element: el, destroy() {} };
    },
  },
  todo: {
    label: 'To-Do',
    icon: ICONS.todo,
    defaultSpan: { colSpan: 4, rowSpan: 4 },
    createContent(widget, onUpdate) {
      if (!widget.todos) widget.todos = [];

      const el = document.createElement('div');
      el.className = 'gutter-todo';

      const list = document.createElement('ul');
      list.className = 'gutter-todo-list';

      const timers = new Map();

      function clearTimer(id) {
        if (timers.has(id)) { clearTimeout(timers.get(id)); timers.delete(id); }
      }

      function scheduleRemoval(item) {
        clearTimer(item.id);
        const remaining = 86400000 - (Date.now() - item.doneAt);
        if (remaining <= 0) {
          widget.todos = widget.todos.filter((t) => t.id !== item.id);
          onUpdate({ todos: widget.todos });
          renderList();
          return;
        }
        timers.set(item.id, setTimeout(() => {
          timers.delete(item.id);
          widget.todos = widget.todos.filter((t) => t.id !== item.id);
          onUpdate({ todos: widget.todos });
          renderList();
        }, remaining));
      }

      const form = document.createElement('form');
      form.className = 'gutter-todo-form';
      const input = document.createElement('input');
      input.type = 'text';
      input.placeholder = 'Add a task...';
      input.className = 'gutter-todo-input';
      input.addEventListener('pointerdown', (e) => e.stopPropagation());
      form.appendChild(input);
      form.addEventListener('submit', (e) => {
        e.preventDefault();
        const text = input.value.trim();
        if (!text) return;
        widget.todos.push({ id: Date.now(), text, done: false });
        input.value = '';
        onUpdate({ todos: widget.todos });
        renderList();
      });
      form.addEventListener('pointerdown', (e) => e.stopPropagation());

      function renderList() {
        list.innerHTML = '';
        for (const item of widget.todos) {
          const li = document.createElement('li');
          li.className = 'gutter-todo-item' + (item.done ? ' is-done' : '');

          const cb = document.createElement('input');
          cb.type = 'checkbox';
          cb.checked = item.done;
          cb.className = 'gutter-todo-cb';
          cb.addEventListener('pointerdown', (e) => e.stopPropagation());
          cb.addEventListener('change', () => {
            item.done = cb.checked;
            if (item.done) {
              item.doneAt = Date.now();
              scheduleRemoval(item);
            } else {
              delete item.doneAt;
              clearTimer(item.id);
            }
            onUpdate({ todos: widget.todos });
            renderList();
          });

          const label = document.createElement('span');
          label.className = 'gutter-todo-text';
          label.textContent = item.text;

          const del = document.createElement('button');
          del.type = 'button';
          del.className = 'gutter-todo-del';
          del.textContent = '×';
          del.addEventListener('pointerdown', (e) => e.stopPropagation());
          del.addEventListener('click', () => {
            widget.todos = widget.todos.filter((t) => t.id !== item.id);
            onUpdate({ todos: widget.todos });
            renderList();
          });

          li.append(cb, label, del);
          list.appendChild(li);
        }
      }

      renderList();
      for (const item of widget.todos) {
        if (item.done && item.doneAt) scheduleRemoval(item);
      }
      el.append(list, form);
      return { element: el, destroy() { for (const t of timers.values()) clearTimeout(t); } };
    },
  },
  reddit: {
    label: 'Reddit',
    icon: ICONS.reddit,
    defaultSpan: { colSpan: 5, rowSpan: 6 },
    createContent(widget, onUpdate) {
      if (!widget.subreddit) widget.subreddit = 'all';

      const el = document.createElement('div');
      el.className = 'gutter-reddit';

      const header = document.createElement('div');
      header.className = 'gutter-reddit-header';
      const subInput = document.createElement('input');
      subInput.type = 'text';
      subInput.className = 'gutter-reddit-sub-input';
      subInput.value = widget.subreddit;
      subInput.placeholder = 'subreddit';
      subInput.addEventListener('pointerdown', (e) => e.stopPropagation());
      subInput.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') {
          widget.subreddit = subInput.value.trim() || 'all';
          onUpdate({ subreddit: widget.subreddit });
          fetchPosts();
        }
      });
      const prefix = document.createElement('span');
      prefix.className = 'gutter-reddit-prefix';
      prefix.textContent = 'r/';
      header.append(prefix, subInput);

      const feed = document.createElement('div');
      feed.className = 'gutter-reddit-feed';

      const detail = document.createElement('div');
      detail.className = 'gutter-reddit-detail';
      detail.hidden = true;

      function showFeed() {
        feed.hidden = false;
        detail.hidden = true;
      }

      function showPost(post) {
        detail.hidden = false;
        feed.hidden = true;
        detail.innerHTML = '';

        const back = document.createElement('button');
        back.type = 'button';
        back.className = 'gutter-reddit-back';
        back.textContent = '← Back';
        back.addEventListener('pointerdown', (e) => e.stopPropagation());
        back.addEventListener('click', showFeed);

        const title = document.createElement('h3');
        title.className = 'gutter-reddit-post-title';
        title.textContent = post.title;

        const meta = document.createElement('div');
        meta.className = 'gutter-reddit-post-meta';
        meta.textContent = `u/${post.author} · ${post.score} pts · ${post.num_comments} comments`;

        const body = document.createElement('div');
        body.className = 'gutter-reddit-post-body';

        if (post.selftext) {
          body.textContent = post.selftext;
        } else if (post.url && /\.(jpg|jpeg|png|gif|webp)(\?.*)?$/i.test(post.url)) {
          const img = document.createElement('img');
          img.src = post.url;
          img.className = 'gutter-reddit-img';
          body.appendChild(img);
        } else if (post.url) {
          const link = document.createElement('a');
          link.href = post.url;
          link.target = '_blank';
          link.rel = 'noopener';
          link.textContent = post.url;
          link.className = 'gutter-reddit-link';
          link.addEventListener('pointerdown', (e) => e.stopPropagation());
          body.appendChild(link);
        }

        detail.append(back, title, meta, body);
        detail.scrollTop = 0;
      }

      function renderPosts(posts) {
        feed.innerHTML = '';
        if (!posts.length) {
          feed.textContent = 'No posts found.';
          return;
        }
        for (const post of posts) {
          const row = document.createElement('div');
          row.className = 'gutter-reddit-row';
          row.addEventListener('pointerdown', (e) => e.stopPropagation());
          row.addEventListener('click', () => showPost(post));

          const score = document.createElement('span');
          score.className = 'gutter-reddit-score';
          score.textContent = post.score;

          const info = document.createElement('div');
          info.className = 'gutter-reddit-info';
          const t = document.createElement('div');
          t.className = 'gutter-reddit-row-title';
          t.textContent = post.title;
          const m = document.createElement('div');
          m.className = 'gutter-reddit-row-meta';
          m.textContent = `u/${post.author} · ${post.num_comments} comments`;
          info.append(t, m);

          row.append(score, info);
          feed.appendChild(row);
        }
      }

      function fetchPosts() {
        feed.innerHTML = '<div class="gutter-reddit-loading">Loading...</div>';
        showFeed();
        fetch(`https://www.reddit.com/r/${encodeURIComponent(widget.subreddit)}.json?limit=25&raw_json=1`)
          .then((r) => r.json())
          .then((json) => {
            const posts = json.data.children.map((c) => c.data);
            renderPosts(posts);
          })
          .catch(() => { feed.textContent = 'Failed to load posts.'; });
      }

      fetchPosts();
      el.append(header, feed, detail);
      return { element: el, destroy() {} };
    },
  },
};


/* -----------------------------------------------------------------------------
   4. PANEL NODE
   Builds the comic^H^H^H^H^H newspaper-panel "chrome" around one widget:
   header strip (drag handle), resize handle, remove button. Built ONCE per
   widget id and then just updated in place — see applyStyle() and render().

   `nodeInfo` is a small mutable record this module keeps per widget. The
   drag/resize handlers close over it (not over individual values), so they
   always see whatever render() most recently wrote into it.
----------------------------------------------------------------------------- */
function applyStyle(nodeInfo) {
  nodeInfo.root.style.left = nodeInfo.pixelLeft + 'px';
  nodeInfo.root.style.top = nodeInfo.pixelTop + 'px';
  nodeInfo.root.style.width = nodeInfo.pixelWidth + 'px';
  nodeInfo.root.style.height = nodeInfo.pixelHeight + 'px';
  nodeInfo.root.style.zIndex = nodeInfo.widget.zIndex;
  // no easing while YOU are moving this panel (feels instant/snappy);
  // easing is restored the moment you let go, or for any panel that gets
  // DISPLACED by a swap instead of dragged directly — that contrast is
  // what sells the "swap".
  nodeInfo.root.style.transition =
    nodeInfo.isDragging || nodeInfo.isResizing
      ? 'none'
      : 'left .16s ease, top .16s ease, width .16s ease, height .16s ease';
}

function createPanelNode(widget) {
  const meta = WIDGET_TYPES[widget.type];
  const nodeInfo = { isDragging: false, isResizing: false };

  const root = document.createElement('div');
  root.className = 'gutter-panel';
  root.addEventListener('pointerdown', () => {
    focusWidget(nodeInfo.widget.id);
    if (!selectedIds.has(nodeInfo.widget.id)) { selectedIds.clear(); render(); }
  });

  const header = document.createElement('div');
  header.className = 'gutter-panel-header';

  const numberEl = document.createElement('span');
  numberEl.className = 'gutter-panel-number'; // text set in render() — it's real, changing data

  const titleEl = document.createElement('span');
  titleEl.className = 'gutter-panel-title';
  titleEl.innerHTML = `${meta.icon}${meta.label}`;

  const removeBtn = document.createElement('button');
  removeBtn.type = 'button';
  removeBtn.className = 'gutter-panel-remove';
  removeBtn.innerHTML = '&times;';
  removeBtn.setAttribute('aria-label', `Remove ${meta.label} article`);
  removeBtn.addEventListener('pointerdown', (e) => e.stopPropagation()); // don't also start a drag
  removeBtn.addEventListener('click', () => removeWidget(nodeInfo.widget.id));

  header.append(numberEl, titleEl, removeBtn);

  const body = document.createElement('div');
  body.className = 'gutter-panel-body';
  const content = meta.createContent(widget, (partial) => updateWidget(nodeInfo.widget.id, partial));
  body.appendChild(content.element);

  const resizeHandle = document.createElement('div');
  resizeHandle.className = 'gutter-panel-resize';
  resizeHandle.setAttribute('aria-hidden', 'true');

  root.append(header, body, resizeHandle);

  /* --- DRAGGING ---
     While the pointer is down, this panel just slides freely, snapping to
     whichever cell the pointer is over — it does NOT check for collisions
     mid-drag. (Earlier versions of this app did, and that caused a real
     bug: a 2x2 panel moving one cell at a time still overlaps its OWN
     previous position, so whatever it had just displaced kept getting
     swapped right back in, forever — it looked "stuck". Resolving the
     swap only once, on release, fixes that.) */
  header.addEventListener('pointerdown', (e) => {
    if (e.target.closest('button')) return; // let the remove button work normally
    focusWidget(nodeInfo.widget.id);

    const thisId = nodeInfo.widget.id;
    const isGroupDrag = selectedIds.has(thisId) && selectedIds.size > 1;
    const dragIds = isGroupDrag ? [...selectedIds] : [thisId];

    const snapshots = dragIds.map((id) => {
      const ni = panelNodes.get(id);
      const w = findWidget(id);
      ni.isDragging = true;
      applyStyle(ni);
      return { id, anchorLeft: ni.pixelLeft, anchorTop: ni.pixelTop, startCol: w.col, startRow: w.row };
    });

    document.body.style.userSelect = 'none';
    const startPointerX = e.clientX;
    const startPointerY = e.clientY;

    function handleMove(moveEvent) {
      const dx = (moveEvent.clientX - startPointerX) / zoom;
      const dy = (moveEvent.clientY - startPointerY) / zoom;
      for (const snap of snapshots) {
        onDragMove(snap.id, snap.anchorLeft + dx, snap.anchorTop + dy);
      }
    }
    function handleUp() {
      document.body.style.userSelect = '';
      for (const snap of snapshots) {
        const ni = panelNodes.get(snap.id);
        ni.isDragging = false;
        applyStyle(ni);
      }
      if (!isGroupDrag) {
        onDragEnd(snapshots[0].id, snapshots[0].startCol, snapshots[0].startRow);
      }
      window.removeEventListener('pointermove', handleMove);
      window.removeEventListener('pointerup', handleUp);
    }

    window.addEventListener('pointermove', handleMove);
    window.addEventListener('pointerup', handleUp);
  });

  /* --- RESIZING --- */
  resizeHandle.addEventListener('pointerdown', (e) => {
    e.stopPropagation(); // don't also trigger a drag
    focusWidget(nodeInfo.widget.id);
    nodeInfo.isResizing = true;
    document.body.style.userSelect = 'none';
    applyStyle(nodeInfo);

    const startPointerX = e.clientX;
    const startPointerY = e.clientY;
    const anchorW = nodeInfo.pixelWidth;
    const anchorH = nodeInfo.pixelHeight;

    function handleMove(moveEvent) {
      const rawW = anchorW + (moveEvent.clientX - startPointerX) / zoom;
      const rawH = anchorH + (moveEvent.clientY - startPointerY) / zoom;
      onResizeCheck(nodeInfo.widget.id, rawW, rawH);
    }
    function handleUp() {
      nodeInfo.isResizing = false;
      document.body.style.userSelect = '';
      applyStyle(nodeInfo);
      window.removeEventListener('pointermove', handleMove);
      window.removeEventListener('pointerup', handleUp);
    }

    window.addEventListener('pointermove', handleMove);
    window.addEventListener('pointerup', handleUp);
  });

  nodeInfo.root = root;
  nodeInfo.numberEl = numberEl;
  nodeInfo.contentDestroy = content.destroy;
  nodeInfo.widget = widget;
  nodeInfo.pixelLeft = colToX(widget.col);
  nodeInfo.pixelTop = rowToY(widget.row);
  nodeInfo.pixelWidth = spanToW(widget.colSpan);
  nodeInfo.pixelHeight = spanToH(widget.rowSpan);
  return nodeInfo;
}


/* -----------------------------------------------------------------------------
   5. APP STATE + RENDER LOOP
   `widgets` is a plain array of objects — col/row/colSpan/rowSpan/zIndex
   are shared by every widget type; anything else (like Note's `content`)
   is specific to that type. Unlike a React version, nothing here is
   immutable: every function below just mutates `widgets` directly and
   then calls render() itself — there's no framework watching for changes.
----------------------------------------------------------------------------- */
function saveWidgets() {
  localStorage.setItem('gutter-widgets', JSON.stringify(widgets));
}

function loadWidgets() {
  try {
    const raw = localStorage.getItem('gutter-widgets');
    return raw ? JSON.parse(raw) : null;
  } catch { return null; }
}

const DEFAULT_WIDGETS = [
  { id: 1, type: 'clock', col: 1, row: 1, colSpan: 2, rowSpan: 2, zIndex: 1, panelNumber: 1 },
  {
    id: 2,
    type: 'note',
    col: 4,
    row: 1,
    colSpan: 4,
    rowSpan: 4,
    zIndex: 2,
    panelNumber: 2,
    content: 'Drag my header onto the clock to swap places with it.\nDrag my bottom-right corner to resize me.',
  },
];

const widgets = loadWidgets() || DEFAULT_WIDGETS.map((w) => ({ ...w }));

let nextId = widgets.reduce((max, w) => Math.max(max, w.id), 0) + 1;
let nextPanelNumber = widgets.reduce((max, w) => Math.max(max, w.panelNumber), 0) + 1;
let topZ = widgets.reduce((max, w) => Math.max(max, w.zIndex), 0);
const panelNodes = new Map(); // widget id -> nodeInfo, so we reuse DOM nodes instead of rebuilding them
const selectedIds = new Set(); // widgets currently selected via marquee

const canvasEl = document.getElementById('canvas');
const layerEl = document.getElementById('canvas-layer');

function findWidget(id) {
  return widgets.find((w) => w.id === id);
}

// Generic small-field updater (used by widget content like Note, and by
// bringing a panel to the front) — NOT used for drag/resize, which have
// their own logic below because they need to check against every widget.
function updateWidget(id, partialChange) {
  const w = findWidget(id);
  if (!w) return;
  Object.assign(w, partialChange);
  render();
}

function removeWidget(id) {
  const index = widgets.findIndex((w) => w.id === id);
  if (index === -1) return;
  widgets.splice(index, 1);
  render();
}

function focusWidget(id) {
  const w = findWidget(id);
  if (!w) return;
  topZ += 1;
  w.zIndex = topZ;
  render();
}

/* --- DRAGGING, PART 1: FOLLOW ---
   Called on every pointer-move while dragging. This ONLY moves the
   dragged panel itself — it deliberately does not look at, or touch, any
   other widget (see the capture-bug note above createPanelNode's drag
   handler for why). */
function onDragMove(id, rawLeft, rawTop) {
  const dragged = findWidget(id);
  if (!dragged) return;
  const targetCol = xToCol(rawLeft);
  const targetRow = yToRow(rawTop);
  if (targetCol === dragged.col && targetRow === dragged.row) return; // no change, skip the re-render
  dragged.col = targetCol;
  dragged.row = targetRow;
  render();
}

/* --- DRAGGING, PART 2: RESOLVE ---
   Called once, when the pointer is released. `startCol`/`startRow` is
   where the dragged panel was BEFORE this drag began — guaranteed to
   still be empty, since nothing else has moved during the drag. That
   guarantee is what makes this safe to resolve in a single step:
     - nobody at the drop spot   -> nothing to do, it just moved there
     - exactly one panel there   -> SWAP: it takes the dragged panel's old
                                     spot (startCol/startRow)
     - more than one panel there -> ambiguous drop — cancel the whole move
                                     and snap back to where it started */
function onDragEnd(id, startCol, startRow) {
  const dragged = findWidget(id);
  if (!dragged) return;

  const overlapping = widgets.filter(
    (w) =>
      w.id !== id &&
      rectsOverlap(dragged.col, dragged.row, dragged.colSpan, dragged.rowSpan, w.col, w.row, w.colSpan, w.rowSpan)
  );

  if (overlapping.length === 0) return; // landed on empty cells, nothing to swap
  if (overlapping.length === 1) {
    const displaced = overlapping[0];
    displaced.col = (dragged.col !== startCol && dragged.col < startCol)
      ? startCol + dragged.colSpan - displaced.colSpan
      : startCol;
    displaced.row = (dragged.row !== startRow && dragged.row < startRow)
      ? startRow + dragged.rowSpan - displaced.rowSpan
      : startRow;
  } else {
    // dropped on more than one panel at once — back out rather than guess
    dragged.col = startCol;
    dragged.row = startRow;
  }
  render();
}

// Same snap-and-commit idea, but for size instead of position. No swap
// concept here — growing a panel just claims more cells.
function onResizeCheck(id, rawW, rawH) {
  const target = findWidget(id);
  if (!target) return;
  const targetColSpan = Math.max(1, Math.round((rawW + GAP) / (CELL_W + GAP)));
  const targetRowSpan = Math.max(1, Math.round((rawH + GAP) / (CELL_H + GAP)));
  if (targetColSpan === target.colSpan && targetRowSpan === target.rowSpan) return;
  target.colSpan = targetColSpan;
  target.rowSpan = targetRowSpan;
  render();
}

function addWidget(type) {
  const meta = WIDGET_TYPES[type];
  const { colSpan, rowSpan } = meta.defaultSpan;
  const { col, row } = findFreeSlot(widgets, colSpan, rowSpan);
  const id = nextId++;
  const panelNumber = nextPanelNumber++;
  topZ += 1;
  widgets.push({ id, type, col, row, colSpan, rowSpan, zIndex: topZ, panelNumber, content: '' });
  render();
  closeAddMenu();
}

// The only render function in the app. Reconciles `widgets` against the
// DOM nodes we already have: removes nodes for anything deleted, creates
// a node for anything new, and updates style/text on everything else —
// it never throws away a node that's still in use, which is what lets the
// CSS transition animate smoothly when a panel's position changes.
function render() {
  saveWidgets();
  const liveIds = new Set(widgets.map((w) => w.id));

  for (const [id, nodeInfo] of panelNodes) {
    if (!liveIds.has(id)) {
      nodeInfo.contentDestroy();
      nodeInfo.root.remove();
      panelNodes.delete(id);
    }
  }

  const sorted = [...widgets].sort((a, b) => a.col - b.col || a.row - b.row);
  sorted.forEach((w, i) => { w.panelNumber = i + 1; });

  for (const widget of widgets) {
    let nodeInfo = panelNodes.get(widget.id);
    if (!nodeInfo) {
      nodeInfo = createPanelNode(widget);
      panelNodes.set(widget.id, nodeInfo);
      layerEl.appendChild(nodeInfo.root);
    }
    nodeInfo.widget = widget; // keep this fresh for the drag/resize handlers
    nodeInfo.pixelLeft = colToX(widget.col);
    nodeInfo.pixelTop = rowToY(widget.row);
    nodeInfo.pixelWidth = spanToW(widget.colSpan);
    nodeInfo.pixelHeight = spanToH(widget.rowSpan);
    nodeInfo.numberEl.textContent = `ARTICLE ${String(widget.panelNumber).padStart(2, '0')}`;
    nodeInfo.root.classList.toggle('is-selected', selectedIds.has(widget.id));
    applyStyle(nodeInfo);
  }
}


/* -----------------------------------------------------------------------------
   6. INIT
   Sizes the canvas from the grid constants, wires up the static
   "+ ADD ARTICLE" button and its dropdown (built from WIDGET_TYPES so a
   new entry there shows up here automatically), then renders for the
   first time.
----------------------------------------------------------------------------- */
const addBtn = document.getElementById('add-btn');
const addMenu = document.getElementById('add-menu');

function closeAddMenu() {
  addMenu.hidden = true;
}

addBtn.addEventListener('click', (e) => {
  e.stopPropagation();
  addMenu.hidden = !addMenu.hidden;
});

document.addEventListener('click', (e) => {
  if (!addMenu.hidden && !addMenu.contains(e.target)) closeAddMenu();
});

for (const [key, meta] of Object.entries(WIDGET_TYPES)) {
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.innerHTML = `${meta.icon}${meta.label}`;
  btn.addEventListener('click', () => addWidget(key));
  addMenu.appendChild(btn);
}

let panX = 0;
let panY = 0;
let zoom = 1;
const ZOOM_MIN = 0.15;
const ZOOM_MAX = 3;

function loadPan() {
  try {
    const raw = localStorage.getItem('gutter-pan');
    if (raw) { const p = JSON.parse(raw); panX = p.x; panY = p.y; zoom = p.zoom || 1; }
  } catch {}
}
function savePan() {
  localStorage.setItem('gutter-pan', JSON.stringify({ x: panX, y: panY, zoom }));
}
loadPan();

function applyPan() {
  layerEl.style.transform = `translate(${panX}px, ${panY}px) scale(${zoom})`;
  const gridSize = (CELL_W + GAP) * zoom;
  const gridSizeY = (CELL_H + GAP) * zoom;
  canvasEl.style.backgroundSize = `${gridSize}px ${gridSizeY}px`;
  canvasEl.style.backgroundPosition = `${panX}px ${panY}px`;
}

function sizeCanvas() {
  canvasEl.style.backgroundImage = 'none';

  GRID_COLS = 9999;
  GRID_ROWS = 9999;
}
sizeCanvas();
applyPan();
window.addEventListener('resize', () => { sizeCanvas(); applyPan(); render(); });

/* --- RIGHT-CLICK PAN ---
   Right-click + drag moves the entire canvas (grid + widgets). */
canvasEl.addEventListener('contextmenu', (e) => e.preventDefault());
canvasEl.addEventListener('pointerdown', (e) => {
  if (e.button !== 2) return;
  e.preventDefault();
  e.stopPropagation();
  document.body.style.userSelect = 'none';
  canvasEl.style.cursor = 'grabbing';

  const startX = e.clientX;
  const startY = e.clientY;
  const origPanX = panX;
  const origPanY = panY;

  function handleMove(ev) {
    panX = origPanX + (ev.clientX - startX);
    panY = origPanY + (ev.clientY - startY);
    applyPan();
  }
  function handleUp() {
    document.body.style.userSelect = '';
    canvasEl.style.cursor = '';
    savePan();
    window.removeEventListener('pointermove', handleMove);
    window.removeEventListener('pointerup', handleUp);
  }
  window.addEventListener('pointermove', handleMove);
  window.addEventListener('pointerup', handleUp);
});

/* --- SCROLL-WHEEL ZOOM ---
   Zooms toward the pointer position so the point under the cursor stays
   fixed. */
canvasEl.addEventListener('wheel', (e) => {
  e.preventDefault();
  const factor = e.deltaY < 0 ? 1.1 : 1 / 1.1;
  const newZoom = Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, zoom * factor));

  const rect = canvasEl.getBoundingClientRect();
  const pointerX = e.clientX - rect.left;
  const pointerY = e.clientY - rect.top;

  panX = pointerX - (pointerX - panX) * (newZoom / zoom);
  panY = pointerY - (pointerY - panY) * (newZoom / zoom);
  zoom = newZoom;

  applyPan();
  savePan();
}, { passive: false });

/* --- MARQUEE SELECTION ---
   Left-click on empty canvas starts a selection rectangle. Widgets
   overlapping the rect on release become selected. Clicking empty
   space without dragging clears the selection. */
{
  let marqueeEl = null;
  let marqueeOriginX = 0;
  let marqueeOriginY = 0;

  function screenToLayer(cx, cy) {
    const rect = canvasEl.getBoundingClientRect();
    return { x: (cx - rect.left - panX) / zoom, y: (cy - rect.top - panY) / zoom };
  }

  canvasEl.addEventListener('pointerdown', (e) => {
    if (e.button !== 0) return;
    if (e.target !== canvasEl && e.target !== layerEl) return;

    selectedIds.clear();
    render();

    const origin = screenToLayer(e.clientX, e.clientY);
    marqueeOriginX = origin.x;
    marqueeOriginY = origin.y;

    marqueeEl = document.createElement('div');
    marqueeEl.className = 'gutter-marquee';
    layerEl.appendChild(marqueeEl);

    document.body.style.userSelect = 'none';

    function updateMarquee(cx, cy) {
      const cur = screenToLayer(cx, cy);

      const left = Math.min(marqueeOriginX, cur.x);
      const top = Math.min(marqueeOriginY, cur.y);
      const width = Math.abs(cur.x - marqueeOriginX);
      const height = Math.abs(cur.y - marqueeOriginY);

      marqueeEl.style.left = left + 'px';
      marqueeEl.style.top = top + 'px';
      marqueeEl.style.width = width + 'px';
      marqueeEl.style.height = height + 'px';

      return { left, top, right: left + width, bottom: top + height };
    }

    function handleMove(moveEvent) {
      const bounds = updateMarquee(moveEvent.clientX, moveEvent.clientY);

      selectedIds.clear();
      for (const w of widgets) {
        const wLeft = colToX(w.col);
        const wTop = rowToY(w.row);
        const wRight = wLeft + spanToW(w.colSpan);
        const wBottom = wTop + spanToH(w.rowSpan);
        if (bounds.left < wRight && bounds.right > wLeft && bounds.top < wBottom && bounds.bottom > wTop) {
          selectedIds.add(w.id);
        }
      }
      render();
    }

    function handleUp() {
      document.body.style.userSelect = '';
      if (marqueeEl) { marqueeEl.remove(); marqueeEl = null; }
      window.removeEventListener('pointermove', handleMove);
      window.removeEventListener('pointerup', handleUp);
    }

    window.addEventListener('pointermove', handleMove);
    window.addEventListener('pointerup', handleUp);
  });
}

render();
