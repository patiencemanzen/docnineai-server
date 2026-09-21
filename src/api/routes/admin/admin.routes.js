
import { Router } from "express";
import { protect } from "../../../middleware/auth.middleware.js";
import { requireRole } from "../../../middleware/auth.middleware.js";
import * as adminCtrl from "../../controllers/admin/admin.controller.js";

const router = Router();


router.use(protect, requireRole("super-admin"));


router.get("/stats", adminCtrl.getStats);


router.get("/users", adminCtrl.listUsers);
router.patch("/users/:id", adminCtrl.updateUser);
router.patch("/users/:id/subscription", adminCtrl.updateUserSubscription);
router.delete("/users/:id", adminCtrl.deleteUser);


router.get("/projects", adminCtrl.listProjects);
router.delete("/projects/:id", adminCtrl.deleteProject);


router.get("/subscriptions", adminCtrl.listSubscriptions);


router.get("/activity", adminCtrl.listActivity);

export default router;
