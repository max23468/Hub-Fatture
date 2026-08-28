function der(tag: number, content: Buffer) {
  const length =
    content.byteLength < 128
      ? Buffer.from([content.byteLength])
      : Buffer.from([0x82, content.byteLength >> 8, content.byteLength & 0xff]);
  return Buffer.concat([Buffer.from([tag]), length, content]);
}

export function signedXml(xml: Buffer) {
  const signedDataOid = Buffer.from([
    0x06, 0x09, 0x2a, 0x86, 0x48, 0x86, 0xf7, 0x0d, 0x01, 0x07, 0x02,
  ]);
  const dataOid = Buffer.from([0x06, 0x09, 0x2a, 0x86, 0x48, 0x86, 0xf7, 0x0d, 0x01, 0x07, 0x01]);
  const encapsulated = der(0x30, Buffer.concat([dataOid, der(0xa0, der(0x04, xml))]));
  const signedData = der(
    0x30,
    Buffer.concat([
      der(0x02, Buffer.from([1])),
      der(0x31, Buffer.alloc(0)),
      encapsulated,
      der(0x31, Buffer.alloc(0)),
    ]),
  );
  return der(0x30, Buffer.concat([signedDataOid, der(0xa0, signedData)]));
}

export async function assertMaterializedP7mEvidence(database: pg.Pool, remoteId: string) {
  const result = await database.query(
    `SELECT array_agg(files.kind ORDER BY files.kind) AS kinds,
            bool_and(files.document_id IS NOT NULL) AS linked,
            min(documents_storage.kind) AS document_storage_kind
     FROM aruba_files files
     LEFT JOIN documents ON documents.id = files.document_id
     LEFT JOIN storage_objects documents_storage
       ON documents_storage.id = documents.storage_object_id
     WHERE files.remote_document_id = (
       SELECT id FROM aruba_remote_documents WHERE remote_id = $1
     )`,
    [remoteId],
  );
  assert.deepEqual(result.rows, [
    {
      kinds: ["ARUBA_P7M", "ARUBA_XML"],
      linked: true,
      document_storage_kind: "ARUBA_XML",
    },
  ]);
}
import assert from "node:assert/strict";

import type pg from "pg";
