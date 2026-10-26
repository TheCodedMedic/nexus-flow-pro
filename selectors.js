/**
 * Flow project page (flow.google.com): Angular + Angular Material, ProseMirror prompt
 * editor, "Start generation" submit button. Class hashes change; prefer role/aria attrs
 * and icon discovery in content.js. Legacy labs.google/Slate selectors kept as fallbacks.
 */
globalThis.FLOW_BATCH_DEFAULT_SELECTORS = {
  promptInput: [
    // Current Flow build (flow.google.com): ProseMirror-based editor.
    '.ProseMirror[contenteditable="true"]',
    // Legacy Slate-based editor (older Flow builds on labs.google).
    'div[role="textbox"][data-slate-editor="true"][contenteditable="true"]',
    'div[contenteditable="true"][data-slate-editor="true"]',
    'div[contenteditable="true"][aria-multiline="true"][role="textbox"]',
    '[data-testid*="prompt" i]',
    'textarea',
  ],

  submitButton: [
    // Current Flow build: exact elements from DOM
    'flow-generate-icon-button button',
    'button.generate-icon-button',
    'button[aria-label="Start generation"]',
    'button[flow-icon-button]',
    'button.generate-icon-button[type="submit"]',
    '.submit-controls flow-generate-icon-button button',
    'flow-generate-icon-button',
    'flow-base-prompt-box button[type="submit"]',
    'button[aria-label*="generation" i]',
    'button[aria-label*="generate" i]',
    'button[aria-label*="submit" i]',
    'button[aria-label*="send" i]',
    'button[aria-label*="run" i]',
    'button[aria-label="Create"]',
    'button[aria-label*="Create" i]',
    'button[data-testid*="submit" i]',
    'button[data-testid*="generate" i]',
    'button[data-testid*="send" i]',
    'button[type="submit"]',
  ],

  uploadButton: [
    'button[aria-label="Add image"]',
    'button[aria-label*="Add image" i]',
    'button[aria-label*="Upload" i]',
    'button .google-symbols:contains("add")', // Note: querySelectorAll doesn't support :contains natively, we will fallback in js
  ],

  // Consent/onboarding overlays. The current build renders these as Angular CDK
  // overlays, so scope the generic ones to .cdk-overlay-container: an unscoped
  // aria-label*="close" would happily click a close button in the app chrome itself.
  dismissOverlays: [
    '.cdk-overlay-container button[aria-label*="close" i]',
    '.cdk-overlay-container button[aria-label*="dismiss" i]',
    '.cdk-overlay-container [mat-dialog-close]',
    'button[aria-label="Close"]',
    'button[aria-label="Dismiss"]',
  ],
};
