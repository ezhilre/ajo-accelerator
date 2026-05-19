/**
 * lib/expression-parser.js — Adobe UPS audience PQL/AST expression normalizer
 *
 * Pure JS, deterministic, zero LLM calls.
 * Converts the raw AST from the UPS audiences API into a simplified intermediate
 * JSON that can be safely passed to the LLM for plain-English translation.
 *
 * Supported nodeTypes:
 *   fnApply, select, fieldLookup, literal, varRef, varDecl,
 *   parameterReference, chain, occurs, lambda
 */

'use strict';

// ── Field path builder ────────────────────────────────────────────────────────
function buildFieldPath(node) {
  if (!node) return '';
  if (!node.object) return node.fieldName || '';
  return `${buildFieldPath(node.object)}.${node.fieldName || ''}`;
}

// ── Literal value formatter ───────────────────────────────────────────────────
function formatLiteralValue(node) {
  if (!node) return null;
  if (node.literalType === 'List') return Array.isArray(node.value) ? node.value : [node.value];
  return node.value !== undefined ? node.value : null;
}

// ── Core recursive normalizer ─────────────────────────────────────────────────
function normalizeNode(node) {
  if (!node || !node.nodeType) return null;

  switch (node.nodeType) {

    case 'fnApply': {
      const fn = (node.fnName || '').toLowerCase();

      // Logical combinators: and / or
      if (fn === 'and' || fn === 'or') {
        const conditions = (node.params || []).map(normalizeNode).filter(Boolean);
        return { type: fn.toUpperCase(), conditions };
      }

      // stringCompare(operator, field, values, caseSensitive)
      if (fn === 'stringcompare') {
        const [opNode, fieldNode, valNode] = node.params || [];
        return {
          type:     'CONDITION',
          field:    fieldNode ? buildFieldPath(fieldNode) : '(unknown)',
          operator: opNode ? (opNode.value || 'equals') : 'equals',
          value:    valNode ? formatLiteralValue(valNode) : null,
        };
      }

      // Equality / comparison operators
      if (['=', '!=', '<', '>', '<=', '>='].includes(fn)) {
        const [left, right] = node.params || [];
        return {
          type:     'CONDITION',
          field:    left  ? buildFieldPath(left)        : '(unknown)',
          operator: fn,
          value:    right ? formatLiteralValue(right)   : null,
        };
      }

      // inAudience membership check
      if (fn === 'inaudience') {
        const nameNode = (node.params || [])[0];
        return {
          type:         'AUDIENCE_MEMBERSHIP',
          audienceName: nameNode ? nameNode.value : '(unknown)',
        };
      }

      // select — sub-collection filtering (e.g. nested accounts array)
      if (fn === 'select') {
        const vars = (node.variables || []).map((v) => ({
          collection: v.from  ? buildFieldPath(v.from)  : '',
          filter:     v.where ? normalizeNode(v.where)  : null,
          alias:      v.varName || '',
        }));
        return { type: 'SELECT_FILTER', variables: vars };
      }

      // Generic fallback
      return {
        type:   'FUNCTION',
        fn:     node.fnName,
        params: (node.params || []).map(normalizeNode).filter(Boolean),
      };
    }

    case 'select': {
      const vars = (node.variables || []).map((v) => ({
        collection: v.from  ? buildFieldPath(v.from)  : '',
        filter:     v.where ? normalizeNode(v.where)  : null,
        alias:      v.varName || '',
      }));
      return { type: 'SELECT_FILTER', variables: vars };
    }

    case 'fieldLookup':
      return { type: 'FIELD', path: buildFieldPath(node) };

    case 'literal':
      return { type: 'VALUE', value: formatLiteralValue(node) };

    case 'varRef':
      return { type: 'VAR_REF', name: node.varName };

    case 'varDecl':
      return {
        type:       'VAR_DECL',
        name:       node.varName,
        collection: node.from  ? buildFieldPath(node.from)  : '',
        filter:     node.where ? normalizeNode(node.where)  : null,
      };

    case 'parameterReference':
      return { type: 'PARAM', position: node.position };

    case 'chain': {
      const source   = node.array ? buildFieldPath(node.array) : '';
      const elements = (node.elements || []).map((el) => ({
        name: el.name,
        what: el.what ? normalizeNode(el.what) : null,
        when: el.when ? normalizeNode(el.when) : null,
      }));
      return { type: 'CHAIN', source, elements };
    }

    case 'occurs': {
      const q     = node.qualification || {};
      const dur   = q.duration || {};
      const count = dur.count ? dur.count.value : '';
      const unit  = dur.unit  ? dur.unit.value  : '';
      const times = q.times   ? normalizeNode(q.times) : null;
      return { type: 'OCCURS', within: `${count} ${unit}`.trim(), times };
    }

    case 'lambda':
      return normalizeNode(node.body);

    default:
      return { type: 'UNSUPPORTED', nodeType: node.nodeType };
  }
}

/**
 * Top-level entry point.
 * Handles both raw AST nodes and the Adobe UPS API wrapper:
 *   { expressionType, mimeType, value: "<json string>" }
 *
 * @param {object|null} expressionData
 * @returns {object|null} normalized intermediate JSON
 */
function normalizeAudienceExpression(expressionData) {
  if (!expressionData) return null;

  let node = expressionData;

  // UPS wraps expression in { value: "<json string>" | object }
  if (expressionData.value !== undefined) {
    if (typeof expressionData.value === 'string') {
      try { node = JSON.parse(expressionData.value); } catch (_) { node = expressionData; }
    } else if (typeof expressionData.value === 'object' && expressionData.value !== null) {
      node = expressionData.value;
    }
  }

  return normalizeNode(node);
}

module.exports = { normalizeAudienceExpression, normalizeNode, buildFieldPath };
