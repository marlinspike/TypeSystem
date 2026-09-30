import { EncryptionConfigError, KeyUnavailableError, type KeyEncryptionKey } from "@typesys/encryption";

/**
 * The two AWS KMS calls this package makes, typed structurally so the AWS
 * SDK v3 `KMS` client (`new KMS({ region })`) fits without this package
 * depending on the SDK.
 */
export interface KmsCommands {
  generateDataKeyWithoutPlaintext(input: { KeyId: string; KeySpec: "AES_256"; EncryptionContext: Record<string, string> }): Promise<{ CiphertextBlob?: Uint8Array }>;
  decrypt(input: { CiphertextBlob: Uint8Array; KeyId: string; EncryptionContext: Record<string, string> }): Promise<{ Plaintext?: Uint8Array }>;
}

export interface AwsKmsKeyOptions {
  /** The KMS key that wraps data keys: a key id, key ARN, alias name (`alias/typesys`), or alias ARN. */
  keyId: string;
}

/** Binds each wrapped data key to its keyring id, so it can't be relabeled as another. */
function context(keyId: string): Record<string, string> {
  return { "typesys:key-id": keyId };
}

/**
 * A symmetric AWS KMS key as a `KeyEncryptionKey` (ADR-0037). New data keys
 * come from `GenerateDataKeyWithoutPlaintext`, so their plaintext never
 * leaves KMS until an instance unwraps them; every `Decrypt` names this KMS
 * key, so a data key wrapped under any other is refused rather than
 * decrypted under whichever key wrapped it.
 */
export class AwsKmsKey implements KeyEncryptionKey {
  readonly name: string;
  private readonly kmsKeyId: string;

  constructor(
    private readonly client: KmsCommands,
    options: AwsKmsKeyOptions
  ) {
    if (!(typeof options.keyId === "string" && options.keyId.trim())) throw new EncryptionConfigError("AwsKmsKey needs the keyId of a KMS key");
    this.kmsKeyId = options.keyId;
    this.name = `aws-kms:${options.keyId}`;
  }

  async generateWrappedKey(keyId: string): Promise<Uint8Array> {
    const { CiphertextBlob } = await this.client.generateDataKeyWithoutPlaintext({ KeyId: this.kmsKeyId, KeySpec: "AES_256", EncryptionContext: context(keyId) });
    if (!CiphertextBlob) throw new KeyUnavailableError(`${this.name} returned no wrapped key for "${keyId}"`);
    return CiphertextBlob;
  }

  async unwrap(wrapped: Uint8Array, keyId: string): Promise<Uint8Array> {
    const { Plaintext } = await this.client.decrypt({ CiphertextBlob: wrapped, KeyId: this.kmsKeyId, EncryptionContext: context(keyId) });
    if (!Plaintext) throw new KeyUnavailableError(`${this.name} returned no plaintext for "${keyId}"`);
    return Plaintext;
  }
}
