# AGENTS.md

Rules to follow to avoid lint errors and TypeScript compilation failures.

---

## 1. Do Not Assign Styles Directly

**Rule:** `obsidianmd/no-static-styles-assignment`

Use `setCssStyles()` or `setCssProps()` instead of setting `element.style.*` directly.

```typescript
// ❌ BAD
text.inputEl.style.width = "80px";

// ✅ GOOD
text.inputEl.setCssStyles({ width: "80px" });
```

---

## 2. Do Not Pass Async Functions Directly to Void Callbacks

**Rule:** `@typescript-eslint/no-misused-promises`

Event listeners expect `void` callbacks. Passing an `async` function triggers a lint warning. Wrap async logic in a void IIFE or delegate to a helper method.

```typescript
// ❌ BAD
saveBtn.addEventListener("click", async () => {
  await this.doSomething();
});

// ✅ GOOD — IIFE
saveBtn.addEventListener("click", () => {
  void (async () => {
    await this.doSomething();
  })();
});

// ✅ GOOD — helper method
saveBtn.addEventListener("click", () => {
  void this.handleSave();
});
```

---

## 3. Do Not Use `any` or Unsafe Member Access

**Rules:** `@typescript-eslint/no-explicit-any`, `@typescript-eslint/no-unsafe-member-access`

Define an explicit `interface` or `type` for every data object, API payload, or database response.

```typescript
// ❌ BAD
const payload: any = { user_id: userId, vault_id: vaultId };
payload.id = deviceId; // unsafe member access

// ✅ GOOD
interface DeviceRegistrationPayload {
  id?: string;
  user_id: string;
  vault_id: string;
}

const payload: DeviceRegistrationPayload = { user_id: userId, vault_id: vaultId };
if (deviceId) payload.id = deviceId;
```

---

## 4. Pre-Commit Validation

Before committing, run both checks. Do not submit if either fails.

```bash
npm run lint   # Oxlint
npm run build  # TypeScript compilation
```