/**
 * Lets libghostty-vt call JavaScript.
 *
 * Its callbacks (write_pty, bell, render_hold...) are C function pointers,
 * which in wasm32 are indices into the module's function table, and a table
 * only holds wasm functions. So each JS function is wrapped in a tiny module
 * that imports it and re-exports it: the export is a wasm function with the
 * C signature, which can go in the table.
 */

/** wasm32 C ABI value types: pointers, size_t, int and bool are i32. */
export type WasmValueType = 'i32' | 'i64';

const VALUE_TYPE_CODE: Record<WasmValueType, number> = { i32: 0x7f, i64: 0x7e };

/** "\0asm", version 1 */
const HEADER = [0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00];
/** One import: "e" "f", a function of type 0 */
const IMPORT_SECTION_BODY = [0x01, 0x01, 0x65, 0x01, 0x66, 0x00, 0x00];
/** One export: "f", function 0 (the import itself) */
const EXPORT_SECTION_BODY = [0x01, 0x01, 0x66, 0x00, 0x00];

/** A module importing `e.f` with the given signature and exporting it as `f`. */
function trampolineModule(params: readonly WasmValueType[], result?: WasmValueType): ArrayBuffer {
  const results = result ? [1, VALUE_TYPE_CODE[result]] : [0];
  // One type: func (params) -> (results)
  const typeBody = [
    0x01,
    0x60,
    params.length,
    ...params.map((p) => VALUE_TYPE_CODE[p]),
    ...results,
  ];
  const section = (id: number, body: number[]) => [id, body.length, ...body];
  return new Uint8Array([
    ...HEADER,
    ...section(1, typeBody),
    ...section(2, IMPORT_SECTION_BODY),
    ...section(7, EXPORT_SECTION_BODY),
  ]).buffer;
}

/**
 * Function-table entries for JS functions, so libghostty-vt can call them
 * through C function pointers.
 */
export class FunctionTable {
  constructor(private readonly table: WebAssembly.Table) {}

  /** Adds `fn` with the given C signature and returns its function pointer. */
  add(
    fn: (...args: any[]) => unknown,
    params: readonly WasmValueType[],
    result?: WasmValueType
  ): number {
    const module = new WebAssembly.Module(trampolineModule(params, result));
    const instance = new WebAssembly.Instance(module, { e: { f: fn } });
    const index = this.table.grow(1);
    this.table.set(index, instance.exports.f as any);
    return index;
  }
}
