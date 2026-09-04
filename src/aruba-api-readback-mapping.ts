import { mapArubaApiInboundGroup } from "./aruba-api-inbound.ts";
import type {
  ArubaApiInvoiceDetail,
  ArubaApiNotificationList,
} from "./integrations/aruba-api.server.ts";

export function arubaApiGroupFromDetail(detail: ArubaApiInvoiceDetail) {
  return {
    id: detail.id,
    filename: detail.filename,
    invoices: detail.invoices.map((invoice) => ({
      invoiceDate: invoice.invoiceDate,
      number: invoice.number,
      documentType: invoice.documentType,
      status: invoice.status,
    })),
  };
}

export function mapArubaApiReadbackGroup(
  detail: ArubaApiInvoiceDetail,
  notifications: ArubaApiNotificationList,
  group: ReturnType<typeof arubaApiGroupFromDetail> = arubaApiGroupFromDetail(detail),
) {
  return mapArubaApiInboundGroup({
    group,
    detail,
    notifications: notifications.notifications.map((notification) => ({
      filename: notification.filename,
      invoiceId: notification.invoiceId,
      docType: notification.docType,
      notificationDate: notification.notificationDate,
      number: notification.number,
      result: notification.result,
      file: notification.file,
    })),
  });
}
