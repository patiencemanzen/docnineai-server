
import { randomUUID } from "crypto";
import { Project } from "../../../models/Project.js";
import { ProjectShare } from "../../../models/ProjectShare.js";
import { User } from "../../../models/User.js";
import { sendProjectInviteEmail } from "../../../config/email.js";
import { syncTeamSeatsAndBilling } from "../../../services/billing.service.js";
import { Subscription } from "../../../models/Subscription.js";
import { getPlan, effectivePlanId } from "../../../config/plans.js";
import ActivityLogService from "../../../services/activity-log.service.js";
import { NotificationService } from "../../../services/notification.service.js";



function forbidden(msg = "Access denied.") {
  const e = new Error(msg);
  e.status = 403;
  return e;
}
function notFound(msg = "Not found.") {
  const e = new Error(msg);
  e.status = 404;
  return e;
}
function planGate(msg, requiredPlan) {
  const e = new Error(msg);
  e.status = 403;
  e.code = "PLAN_GATE";
  e.requiredPlan = requiredPlan;
  return e;
}

async function assertShareAllowed(ownerId, role, { countTowardLimit = true } = {}) {
  const sub = await Subscription.findOne({ userId: ownerId }).lean();
  const planId = effectivePlanId(sub);
  const features = getPlan(planId).features;

  if (role === "editor" && !features.shareEdit) {
    throw planGate(
      "Edit sharing requires the Pro plan or higher.",
      "pro",
    );
  }
  if (role === "viewer" && !features.shareViewOnly) {
    throw planGate(
      "Project sharing requires the Starter plan or higher.",
      "starter",
    );
  }

  if (
    countTowardLimit &&
    features.maxShares !== null &&
    features.maxShares !== undefined
  ) {
    const count = await ProjectShare.countDocuments({
      ownerId,
      status: { $in: ["pending", "accepted"] },
    });
    if (count >= features.maxShares) {
      throw planGate(
        `You've reached the ${features.maxShares}-share limit on your current plan.`,
        "pro",
      );
    }
  }
}


async function assertOwner(projectId, userId) {
  const project = await Project.findById(projectId).lean();
  if (!project) throw notFound("Project not found.");
  if (project.userId.toString() !== userId.toString())
    throw forbidden("Only the project owner can manage sharing.");
  return project;
}




export async function inviteUsers(projectId, ownerId, invites) {
  const project = await assertOwner(projectId, ownerId);
  const owner = await User.findById(ownerId).select("name email").lean();

  const results = [];

  for (const { email, role } of invites) {
    const lc = email.toLowerCase().trim();


    if (lc === owner.email) {
      results.push({
        email: lc,
        status: "skipped",
        reason: "You are the owner.",
      });
      continue;
    }


    const existing = await ProjectShare.findOne({
      projectId,
      inviteeEmail: lc,
      status: { $in: ["pending", "accepted"] },
    });

    if (existing) {
      if (existing.status === "accepted") {
        results.push({
          email: lc,
          status: "skipped",
          reason: "Already has access.",
        });
        continue;
      }

      existing.token = randomUUID();
      existing.role = role;
      existing.expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);
      await existing.save();
      await sendProjectInviteEmail({
        to: lc,
        inviterName: owner.name,
        projectName: project.meta?.name || project.repoName,
        role,
        token: existing.token,
      });
      results.push({
        email: lc,
        status: "resent",
        share: _serialize(existing),
      });
      continue;
    }


    await ProjectShare.deleteOne({
      projectId,
      inviteeEmail: lc,
      status: "revoked",
    });

    await assertShareAllowed(ownerId, role);


    const inviteeUser = await User.findOne({ email: lc }).select("_id").lean();

    const share = await ProjectShare.create({
      projectId,
      ownerId,
      inviteeEmail: lc,
      inviteeUserId: inviteeUser?._id ?? null,
      role,
    });

    await sendProjectInviteEmail({
      to: lc,
      inviterName: owner.name,
      projectName: project.meta?.name || project.repoName,
      role,
      token: share.token,
    });

    results.push({ email: lc, status: "invited", share: _serialize(share) });

    ActivityLogService.log({
      userId: ownerId,
      action: "SHARE_INVITE_SENT",
      projectId,
      projectName: project.meta?.name || project.repoName,
      resourceId: share._id.toString(),
      resourceType: "share",
      metadata: { inviteeEmail: lc, role },
    });


    if (inviteeUser?._id) {
      NotificationService.create({
        userId: inviteeUser._id,
        type: "SHARE_INVITE_RECEIVED",
        projectId: share.projectId,
        actionUrl: `/invite/${share.token}`,
        metadata: {
          inviterName: owner.name,
          projectName: project.meta?.name || project.repoName,
        },
      });
    }
  }

  return results;
}


export async function listAccess(projectId, ownerId) {
  await assertOwner(projectId, ownerId);

  const shares = await ProjectShare.find({
    projectId,
    status: { $in: ["pending", "accepted"] },
  })
    .populate("inviteeUserId", "name email")
    .sort({ createdAt: -1 })
    .lean();

  return shares.map(_serialize);
}


export async function changeRole(projectId, shareId, ownerId, newRole) {
  await assertOwner(projectId, ownerId);

  const share = await ProjectShare.findOne({
    _id: shareId,
    projectId,
    status: { $in: ["pending", "accepted"] },
  });
  if (!share) throw notFound("Share entry not found.");

  await assertShareAllowed(ownerId, newRole, { countTowardLimit: false });

  share.role = newRole;
  await share.save();

  ActivityLogService.log({
    userId: ownerId,
    action: "SHARE_ROLE_CHANGED",
    projectId,
    resourceId: shareId.toString(),
    resourceType: "share",
    metadata: { inviteeEmail: share.inviteeEmail, newRole },
  });

  if (share.inviteeUserId) {
    const project = await Project.findById(projectId).select("meta repoName").lean();
    NotificationService.create({
      userId: share.inviteeUserId,
      type: "SHARE_ROLE_CHANGED",
      projectId,
      actionUrl: `/projects/${projectId}`,
      metadata: {
        projectName: project?.meta?.name || project?.repoName || "a project",
        newRole,
      },
    });
  }

  return _serialize(share);
}


export async function revokeAccess(projectId, shareId, ownerId) {
  await assertOwner(projectId, ownerId);

  const share = await ProjectShare.findOne({ _id: shareId, projectId });
  if (!share) throw notFound("Share entry not found.");

  share.status = "revoked";
  await share.save();

  ActivityLogService.log({
    userId: ownerId,
    action: "SHARE_MEMBER_REMOVED",
    projectId,
    resourceId: shareId.toString(),
    resourceType: "share",
    metadata: { inviteeEmail: share.inviteeEmail },
  });

  if (share.inviteeUserId) {
    const project = await Project.findById(projectId).select("meta repoName").lean();
    NotificationService.create({
      userId: share.inviteeUserId,
      type: "SHARE_MEMBER_REMOVED",
      projectId,
      actionUrl: "/projects",
      metadata: {
        projectName: project?.meta?.name || project?.repoName || "a project",
      },
    });
  }
  await syncTeamSeatsAndBilling(projectId, ownerId);
}


export async function resendInvite(projectId, shareId, ownerId) {
  const project = await assertOwner(projectId, ownerId);
  const owner = await User.findById(ownerId).select("name email").lean();

  const share = await ProjectShare.findOne({
    _id: shareId,
    projectId,
    status: "pending",
  });
  if (!share) throw notFound("Pending invite not found.");

  share.token = randomUUID();
  share.expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);
  await share.save();

  await sendProjectInviteEmail({
    to: share.inviteeEmail,
    inviterName: owner.name,
    projectName: project.meta?.name || project.repoName,
    role: share.role,
    token: share.token,
  });

  return _serialize(share);
}


export async function cancelInvite(projectId, shareId, ownerId) {
  await assertOwner(projectId, ownerId);

  const share = await ProjectShare.findOne({
    _id: shareId,
    projectId,
    status: "pending",
  });
  if (!share) throw notFound("Pending invite not found.");

  await share.deleteOne();
}


export async function acceptInvite(token, userId) {
  const share = await ProjectShare.findOne({ token, status: "pending" });
  if (!share) throw notFound("Invalid or expired invite link.");

  if (share.expiresAt < new Date()) {
    throw forbidden(
      "This invite link has expired. Ask the owner to resend it.",
    );
  }

  share.status = "accepted";
  if (userId) share.inviteeUserId = userId;
  share.token = randomUUID();
  await share.save();

  ActivityLogService.log({
    userId: userId ?? share.inviteeUserId,
    action: "SHARE_INVITE_ACCEPTED",
    projectId: share.projectId,
    resourceId: share._id.toString(),
    resourceType: "share",
    metadata: { inviteeEmail: share.inviteeEmail, role: share.role },
  });


  const project = await Project.findById(share.projectId).select("userId meta repoName");
  if (project) {
    await syncTeamSeatsAndBilling(project._id.toString(), project.userId.toString());
    const inviteeName = userId
      ? (await User.findById(userId).select("name").lean())?.name ?? share.inviteeEmail
      : share.inviteeEmail;
    NotificationService.create({
      userId: project.userId,
      type: "SHARE_INVITE_ACCEPTED",
      projectId: project._id,
      actionUrl: `/projects/${project._id}`,
      metadata: {
        inviteeName,
        projectName: project.meta?.name || project.repoName || "your project",
      },
    });
  }

  return { projectId: share.projectId.toString(), role: share.role };
}


export async function getSharedProjects(userId) {

  const user = await User.findById(userId).select("email").lean();

  const query = user
    ? {
        status: "accepted",
        $or: [{ inviteeUserId: userId }, { inviteeEmail: user.email }],
      }
    : { inviteeUserId: userId, status: "accepted" };

  const shares = await ProjectShare.find(query).lean();
  if (shares.length === 0) return [];

  const projectIds = shares.map((s) => s.projectId);
  const projects = await Project.find({ _id: { $in: projectIds } }).lean();

  const roleMap = {};
  for (const s of shares) roleMap[s.projectId.toString()] = s.role;

  return projects.map((p) => ({ ...p, shareRole: roleMap[p._id.toString()] }));
}


export async function assertProjectAccess(projectId, userId) {
  const project = await Project.findById(projectId).lean();
  if (!project) throw notFound("Project not found.");

  if (project.userId.toString() === userId.toString()) {
    return { isOwner: true, role: "owner", project };
  }


  const user = await User.findById(userId).select("email").lean();
  const share = await ProjectShare.findOne({
    projectId,
    status: "accepted",
    $or: [
      { inviteeUserId: userId },
      ...(user ? [{ inviteeEmail: user.email }] : []),
    ],
  }).lean();

  if (!share) throw forbidden("You do not have access to this project.");

  return { isOwner: false, role: share.role, project };
}


export async function getShareRole(projectId, userId) {
  const project = await Project.findById(projectId).select("userId").lean();
  if (!project) return null;
  if (project.userId.toString() === userId.toString()) return "owner";

  const user = await User.findById(userId).select("email").lean();
  const share = await ProjectShare.findOne({
    projectId,
    status: "accepted",
    $or: [
      { inviteeUserId: userId },
      ...(user ? [{ inviteeEmail: user.email }] : []),
    ],
  }).lean();

  return share?.role ?? null;
}



function _serialize(share) {
  const s = share.toObject ? share.toObject() : { ...share };
  delete s.token;
  return {
    _id: s._id,
    projectId: s.projectId,
    inviteeEmail: s.inviteeEmail,
    inviteeUser: s.inviteeUserId
      ? typeof s.inviteeUserId === "object" && s.inviteeUserId.name
        ? {
            _id: s.inviteeUserId._id,
            name: s.inviteeUserId.name,
            email: s.inviteeUserId.email,
          }
        : { _id: s.inviteeUserId }
      : null,
    role: s.role,
    status: s.status,
    createdAt: s.createdAt,
    updatedAt: s.updatedAt,
    expiresAt: s.expiresAt,
  };
}
