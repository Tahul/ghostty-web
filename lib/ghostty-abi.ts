/**
 * libghostty-vt's type manifest (`ghostty_type_json`): struct sizes, field
 * offsets, enum values and the bit positions of packed values such as cells.
 *
 * Upstream publishes these instead of promising a frozen ABI, so the bindings
 * look them up once when the module loads and keep plain numbers for the hot
 * paths. A missing name throws at load time rather than misreading memory later.
 */

interface FieldInfo {
  offset: number;
  size: number;
  type: string;
}

/** A packed field: `width` bits starting at bit `lsb` of its container. */
export interface BitField {
  lsb: number;
  width: number;
}

interface PackedBit extends BitField {
  type?: string;
  kind?: string;
  arms?: Record<string, { bits: Record<string, BitField> }>;
}

interface TypeInfo {
  kind: string;
  size: number;
  fields?: Record<string, FieldInfo>;
  values?: Record<string, number>;
  bits?: Record<string, PackedBit>;
}

interface ManifestJson {
  abi: { target: string; pointer_size: number; usize_size: number; endian: string };
  library_version: string;
  commit: string;
  types: Record<string, TypeInfo>;
}

export class TypeManifest {
  readonly version: string;
  private readonly types: Record<string, TypeInfo>;

  constructor(json: ManifestJson) {
    const { abi } = json;
    // The bindings read memory as little-endian wasm32 (4-byte pointers and size_t)
    if (abi.endian !== 'little' || abi.pointer_size !== 4 || abi.usize_size !== 4) {
      throw new Error(`Unsupported libghostty-vt ABI: ${JSON.stringify(abi)}`);
    }
    this.version = json.library_version;
    this.types = json.types;
  }

  /** Reads the manifest the module embeds (a NUL-terminated JSON string). */
  static read(typeJson: () => number, memory: WebAssembly.Memory): TypeManifest {
    const ptr = typeJson() >>> 0;
    const bytes = new Uint8Array(memory.buffer);
    let end = ptr;
    while (end < bytes.length && bytes[end] !== 0) end++;
    return new TypeManifest(JSON.parse(new TextDecoder().decode(bytes.subarray(ptr, end))));
  }

  private type(name: string): TypeInfo {
    const type = this.types[name];
    if (!type) throw new Error(`libghostty-vt manifest has no type ${name}`);
    return type;
  }

  size(type: string): number {
    return this.type(type).size;
  }

  offset(type: string, field: string): number {
    const info = this.type(type).fields?.[field];
    if (!info) throw new Error(`libghostty-vt manifest has no field ${type}.${field}`);
    return info.offset;
  }

  enumValue(type: string, name: string): number {
    const value = this.type(type).values?.[name];
    if (value === undefined) throw new Error(`libghostty-vt manifest has no value ${type}.${name}`);
    return value;
  }

  /** A field of a packed type, e.g. `bits('GhosttyCell', 'style_id')`. */
  bits(type: string, field: string): BitField {
    const info = this.type(type).bits?.[field];
    if (!info) throw new Error(`libghostty-vt manifest has no bits ${type}.${field}`);
    return { lsb: info.lsb, width: info.width };
  }

  /**
   * A field inside one arm of a packed union, with its position made absolute:
   * e.g. the codepoint inside a cell's `content` when the tag is CODEPOINT.
   */
  armBits(type: string, union: string, arm: string, field: string): BitField {
    const info = this.type(type).bits?.[union];
    const inner = info?.arms?.[arm]?.bits?.[field];
    if (!info || !inner) {
      throw new Error(`libghostty-vt manifest has no bits ${type}.${union}.${arm}.${field}`);
    }
    return { lsb: info.lsb + inner.lsb, width: inner.width };
  }
}

/**
 * Reads a bit field out of a 64-bit value split into its low and high 32-bit
 * words (wasm memory read through a Uint32Array), without BigInt.
 */
export function readBits(lo: number, hi: number, field: BitField): number {
  const { lsb, width } = field;
  const mask = width >= 32 ? 0xffffffff : (1 << width) - 1;
  if (lsb >= 32) return ((hi >>> (lsb - 32)) & mask) >>> 0;
  if (lsb + width <= 32) return ((lo >>> lsb) & mask) >>> 0;
  // Straddles the two words
  return (((lo >>> lsb) | (hi << (32 - lsb))) & mask) >>> 0;
}
