import { Router } from "express";
import { protect } from "../../../middleware/auth.middleware.js";
import { wrap } from "../../../utils/response.util.js";
import * as ctrl from "../../controllers/billing/billing.controller.js";
import { apiLimiter } from "../../../middleware/rateLimiter.middleware.js";

const router = Router();

router.get("/plans", wrap(ctrl.getPlans));

router.use(protect, apiLimiter);

router.get("/subscription", wrap(ctrl.getSubscription));
router.get("/team-seats", wrap(ctrl.getTeamSeatsDetails));
router.post("/checkout", wrap(ctrl.checkout));
router.post("/verify-payment", wrap(ctrl.verifyPayment));
router.post("/change-plan", wrap(ctrl.changePlanHandler));
router.post("/cancel", wrap(ctrl.cancelHandler));
router.post("/pause", wrap(ctrl.pauseHandler));
router.post("/seats", wrap(ctrl.addSeatsHandler));

router.get("/payment-methods", wrap(ctrl.getPaymentMethods));
router.delete("/payment-methods/:id", wrap(ctrl.deletePaymentMethod));
router.patch("/payment-methods/:id/default", wrap(ctrl.setDefaultPaymentMethod));

router.get("/history", wrap(ctrl.getBillingHistoryHandler));
router.get("/invoices/:id/pdf", ctrl.downloadInvoicePdf);
router.patch("/invoices/:id/details", wrap(ctrl.updateInvoiceDetails));

export default router;
