import { InvalidInputError } from "@typesys/core";

/**
 * An operation that needs a field's plaintext in the store — a range filter,
 * a sort, an aggregation, a substring search, a key-based relationship —
 * asked of a field the store holds only as ciphertext (ADR-0033). The caller
 * asked for something this field can't do, so it is an `InvalidInputError`.
 */
export class EncryptedFieldError extends InvalidInputError {
  constructor(message: string) {
    super(message);
    this.name = "EncryptedFieldError";
  }
}

/**
 * A stored value that could not be decrypted: not an envelope, a key the
 * keyring doesn't hold, a failed GCM tag (tampered, truncated, moved, or the
 * wrong key), or a blind index that doesn't match its value. The read fails
 * closed. The message names where, never what.
 */
export class DecryptionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DecryptionError";
  }
}

/** A key or encryption configuration that can't be used — including an Action the configuration doesn't account for. */
export class EncryptionConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "EncryptionConfigError";
  }
}

/**
 * Key material that can't be had (ADR-0037): a KMS that is unreachable,
 * denies access, or has disabled the key — at startup, or once a lease has
 * run out without a successful refresh. Everything that needs the key fails
 * closed. The message names the key id and KMS key, never material.
 */
export class KeyUnavailableError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "KeyUnavailableError";
  }
}
