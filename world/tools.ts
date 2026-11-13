// biome-ignore-all lint/style/useNamingConvention: tool names are snake_case on the wire.
// Every tool an agent can call, by the name it calls it with: POST /tools/<name>.
import { bookExam, checkRelease, fileEntry, listHolds, payFee } from "./customs-tools";
import {
  emailImporter,
  listOpenShipments,
  lookupTariff,
  proposeCode,
  readProposals,
  readShipment,
  searchDocuments,
} from "./document-tools";
import type { ToolCall, ToolResult } from "./tool-helpers";

export const TOOLS: Record<string, (call: ToolCall) => ToolResult> = {
  list_open_shipments: listOpenShipments,
  read_shipment: readShipment,
  search_documents: searchDocuments,
  propose_code: proposeCode,
  read_proposals: readProposals,
  lookup_tariff: lookupTariff,
  email_importer: emailImporter,
  file_entry: fileEntry,
  list_holds: listHolds,
  book_exam: bookExam,
  pay_fee: payFee,
  check_release: checkRelease,
};
