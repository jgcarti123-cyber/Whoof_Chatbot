'use strict';

/**
 * structured.js — the contract between the LLM and the UI for structured answers.
 *
 * One generic StructuredAnswer shape renders as a card (header · stats · sections ·
 * callouts · tags · actions). The model decides per answer whether to use it; `kind`
 * is informational only and never gates which layouts are legal — a "generic" kind can
 * use every layout, which is what lets the mechanism extend to new answer types with no
 * code change.
 *
 * Two things live here and nowhere else:
 *   STRUCTURED_ANSWER_SCHEMA  — JSON Schema, used verbatim as the Anthropic tool
 *                               input_schema for send_structured_reply.
 *   validateStructuredAnswer  — defensive server-side validation. Cleans malformed
 *                               sub-parts (drops a bad section rather than failing the
 *                               whole turn) and only reports invalid when a load-bearing
 *                               field is missing, so the caller can fall back to text.
 *
 * Foundation scope: layouts are limited to 'timeline' and 'list'. 'badges' and 'table'
 * are added in a later pass — keep the enum here and the renderer in sync.
 */

// The layouts the renderer implements today. Unknown layouts coerce to 'list'.
const LAYOUTS = ['timeline', 'list'];
const TONES = ['info', 'warning', 'success'];

// JSON Schema for the send_structured_reply tool. `sections[].items` uses one flat
// object that covers every layout's fields (label/icon/details[] for timeline,
// label/detail for list) instead of a oneOf union — simpler for the model and robust to
// validate. The renderer reads the fields relevant to each layout.
const STRUCTURED_ANSWER_SCHEMA = {
  type: 'object',
  properties: {
    version: { type: 'integer', enum: [1] },
    kind: {
      type: 'string',
      description:
        'Open label for the answer shape: "diet", "training", "health_summary", "grooming", "weight_trend", "vaccination", "generic", etc. Informational only.',
    },
    subject: {
      type: 'object',
      description: 'Who/what the answer is about, for the personalised header.',
      properties: {
        name: { type: 'string', description: 'e.g. "Monkey"' },
        meta: { type: 'string', description: 'e.g. "Golden retriever · 2 yrs · 29.5 kg ideal"' },
        avatarIcon: { type: 'string' },
      },
      required: ['name'],
    },
    header: {
      type: 'object',
      properties: {
        title: { type: 'string', description: 'e.g. "Monkey\'s diet plan"' },
        icon: { type: 'string' },
      },
      required: ['title'],
    },
    stats: {
      type: 'array',
      description: '2-4 glanceable metric tiles. value is a pre-formatted string (e.g. "1,200-1,400").',
      items: {
        type: 'object',
        properties: {
          label: { type: 'string' },
          value: { type: 'string' },
          unit: { type: 'string' },
        },
        required: ['label', 'value'],
      },
    },
    sections: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          heading: { type: 'string' },
          layout: { type: 'string', enum: LAYOUTS },
          items: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                label: { type: 'string' },
                icon: { type: 'string' },
                detail: { type: 'string', description: 'list layout: one supporting line' },
                details: {
                  type: 'array',
                  items: { type: 'string' },
                  description: 'timeline layout: sub-points under the label',
                },
              },
              required: ['label'],
            },
          },
        },
        required: ['heading', 'layout', 'items'],
      },
    },
    callouts: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          tone: { type: 'string', enum: TONES },
          icon: { type: 'string' },
          title: { type: 'string' },
          body: { type: 'string' },
        },
        required: ['tone', 'title', 'body'],
      },
    },
    tags: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          label: { type: 'string' },
          group: { type: 'string' },
        },
        required: ['label'],
      },
    },
    actions: {
      type: 'array',
      description:
        'Buttons that trigger real app features. type is one of: save_decision, open_screen, set_reminder, log_event. Only save_decision and open_screen are wired today; the rest render disabled.',
      items: {
        type: 'object',
        properties: {
          label: { type: 'string' },
          icon: { type: 'string' },
          type: { type: 'string' },
          payload: { type: 'object' },
        },
        required: ['label', 'type'],
      },
    },
    fallbackText: {
      type: 'string',
      description:
        'REQUIRED. A complete plain-text rendering of the same answer — used for accessibility, search, memory, and as the fallback if the card cannot render.',
    },
  },
  required: ['version', 'kind', 'header', 'fallbackText'],
};

// ── Validation helpers ───────────────────────────────────────────────────────
const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const str = (v) => (typeof v === 'string' ? v.trim() : '');
const asStr = (v) => {
  if (typeof v === 'string') return v.trim();
  if (typeof v === 'number' || typeof v === 'boolean') return String(v);
  return '';
};

/**
 * Validate + clean a candidate StructuredAnswer. Returns { valid, value, errors }.
 * Malformed optional blocks are dropped, not fatal. `valid` is false only when a
 * load-bearing field is missing (header.title or fallbackText) — at that point the
 * card cannot be trusted and the caller should fall back to text.
 */
function validateStructuredAnswer(input) {
  const errors = [];
  if (!isObj(input)) {
    return { valid: false, value: null, errors: ['payload is not an object'] };
  }

  const title = isObj(input.header) ? str(input.header.title) : '';
  const fallbackText = str(input.fallbackText);
  if (!title) errors.push('header.title is required');
  if (!fallbackText) errors.push('fallbackText is required');

  const out = {
    version: 1,
    kind: str(input.kind) || 'generic',
    header: { title, ...(isObj(input.header) && str(input.header.icon) ? { icon: str(input.header.icon) } : {}) },
    fallbackText,
  };

  if (isObj(input.subject) && str(input.subject.name)) {
    out.subject = { name: str(input.subject.name) };
    if (str(input.subject.meta)) out.subject.meta = str(input.subject.meta);
    if (str(input.subject.avatarIcon)) out.subject.avatarIcon = str(input.subject.avatarIcon);
  }

  if (Array.isArray(input.stats)) {
    const stats = input.stats
      .filter(isObj)
      .map((s) => ({ label: str(s.label), value: asStr(s.value), ...(str(s.unit) ? { unit: str(s.unit) } : {}) }))
      .filter((s) => s.label && s.value);
    if (stats.length) out.stats = stats;
  }

  if (Array.isArray(input.sections)) {
    const sections = input.sections
      .filter(isObj)
      .map((sec) => {
        const heading = str(sec.heading);
        const layout = LAYOUTS.includes(sec.layout) ? sec.layout : 'list';
        const items = Array.isArray(sec.items)
          ? sec.items
              .filter(isObj)
              .map((it) => {
                const item = { label: str(it.label) };
                if (str(it.icon)) item.icon = str(it.icon);
                if (str(it.detail)) item.detail = str(it.detail);
                if (Array.isArray(it.details)) {
                  const details = it.details.map(asStr).filter(Boolean);
                  if (details.length) item.details = details;
                }
                return item;
              })
              .filter((it) => it.label)
          : [];
        return { heading, layout, items };
      })
      .filter((sec) => sec.heading && sec.items.length);
    if (sections.length) out.sections = sections;
  }

  if (Array.isArray(input.callouts)) {
    const callouts = input.callouts
      .filter(isObj)
      .map((c) => ({
        tone: TONES.includes(c.tone) ? c.tone : 'info',
        title: str(c.title),
        body: str(c.body),
        ...(str(c.icon) ? { icon: str(c.icon) } : {}),
      }))
      .filter((c) => c.title && c.body);
    if (callouts.length) out.callouts = callouts;
  }

  if (Array.isArray(input.tags)) {
    const tags = input.tags
      .filter(isObj)
      .map((t) => ({ label: str(t.label), ...(str(t.group) ? { group: str(t.group) } : {}) }))
      .filter((t) => t.label);
    if (tags.length) out.tags = tags;
  }

  if (Array.isArray(input.actions)) {
    const actions = input.actions
      .filter(isObj)
      .map((a) => ({
        label: str(a.label),
        type: str(a.type),
        ...(str(a.icon) ? { icon: str(a.icon) } : {}),
        payload: isObj(a.payload) ? a.payload : {},
      }))
      .filter((a) => a.label && a.type);
    if (actions.length) out.actions = actions;
  }

  return { valid: errors.length === 0, value: out, errors };
}

module.exports = { STRUCTURED_ANSWER_SCHEMA, validateStructuredAnswer, LAYOUTS, TONES };
