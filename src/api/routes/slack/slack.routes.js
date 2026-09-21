
import express from "express";
import {
  setCustomSlackCredentials,
  initiateSlackOAuth,
  handleSlackCallback,
  handleSlashCommand,
  handleSlackEvent,
  getSlackConfig,
  updateSlackConfig,
  disconnectSlack,
} from "../../controllers/slack/slack.controller.js";
import { protect } from "../../../middleware/auth.middleware.js";

const router = express.Router();





router.post("/credentials/:projectId", protect, setCustomSlackCredentials);




router.post("/oauth/start", protect, initiateSlackOAuth);


router.get("/oauth/callback", handleSlackCallback);




router.post("/commands", handleSlashCommand);


router.post("/events", handleSlackEvent);




router.get("/config/:projectId", protect, getSlackConfig);


router.put("/config/:projectId", protect, updateSlackConfig);


router.delete("/:projectId", protect, disconnectSlack);

export default router;
