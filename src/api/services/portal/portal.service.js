
import bcrypt from "bcryptjs";
import { Portal } from "../../../models/Portal.js";
import { Project } from "../../../models/Project.js";
import { Subscription } from "../../../models/Subscription.js";
import { getPlan, effectivePlanId } from "../../../config/plans.js";
import ActivityLogService from "../../../services/activity-log.service.js";
import { NotificationService } from "../../../services/notification.service.js";


export const SECTION_KEYS = [
  "readme",
  "internalDocs",
  "apiReference",
  "schemaDocs",
  "securityReport",
];

export const SECTION_LABELS = {
  readme: "README",
  internalDocs: "Internal Docs",
  apiReference: "API Reference",
  schemaDocs: "Schema Docs",
  securityReport: "Security Report",
};



function slugify(str) {
  return str
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60);
}

async function generateUniqueSlug(repoOwner, repoName) {
  const base = slugify(`${repoOwner}-${repoName}`);

  let candidate = base;
  let attempt = 0;
  while (await Portal.exists({ slug: candidate })) {
    attempt++;
    candidate = `${base}-${attempt}`;
  }
  return candidate;
}



async function requireOwner(projectId, userId) {
  const project = await Project.findById(projectId)
    .select("userId repoOwner repoName")
    .lean();
  if (!project)
    throw Object.assign(new Error("Project not found."), {
      status: 404,
      code: "NOT_FOUND",
    });
  if (String(project.userId) !== String(userId))
    throw Object.assign(
      new Error("Only the project owner can manage the portal."),
      { status: 403, code: "FORBIDDEN" },
    );
  return project;
}



function mergeOutput(project) {
  const merged = {};
  for (const key of SECTION_KEYS) {
    merged[key] = project.editedOutput?.[key] || project.output?.[key] || "";
  }
  return merged;
}




export async function getOrCreate(projectId, userId) {
  const project = await requireOwner(projectId, userId);
  let portal = await Portal.findOne({ projectId });
  if (!portal) {
    const slug = await generateUniqueSlug(project.repoOwner, project.repoName);
    portal = await Portal.create({ projectId, slug });
  }
  return portal.toObject();
}


export async function getPortalForOwner(projectId, userId) {
  await requireOwner(projectId, userId);
  let portal = await Portal.findOne({ projectId });
  if (!portal) return null;
  return portal.toObject();
}


export async function updatePortal(projectId, userId, body) {
  await requireOwner(projectId, userId);

  let portal = await Portal.findOne({ projectId });
  if (!portal) {

    const proj = await Project.findById(projectId)
      .select("repoOwner repoName")
      .lean();
    const slug = await generateUniqueSlug(proj.repoOwner, proj.repoName);
    portal = new Portal({ projectId, slug });
  }

  const allowed = [
    "branding",
    "sections",
    "seoTitle",
    "seoDescription",
    "customDomain",
    "accessMode",
    "templateId",
  ];
  for (const key of allowed) {
    if (body[key] !== undefined) portal[key] = body[key];
  }

  if (body.customDomain) {
    const sub = await Subscription.findOne({ userId }).lean();
    const features = getPlan(effectivePlanId(sub)).features;
    if (!features.customDomain) {
      throw Object.assign(
        new Error("Custom domains require the Pro plan or higher."),
        { status: 403, code: "PLAN_GATE" },
      );
    }
  }

  if (portal.branding?.footerLinks) {
    portal.branding.footerLinks = portal.branding.footerLinks.filter((link) => {
      try {
        const href = new URL(String(link.href || ""));
        return href.protocol === "https:" || href.protocol === "http:";
      } catch {
        return false;
      }
    });
  }


  if (body.password !== undefined) {
    if (body.password === null || body.password === "") {

      portal.passwordHash = undefined;
      portal.accessMode = "public";
    } else {
      portal.passwordHash = await bcrypt.hash(String(body.password), 10);
      portal.accessMode = "password";
    }
  }

  await portal.save();
  ActivityLogService.log({
    userId,
    action: "PORTAL_SETTINGS_UPDATED",
    projectId,
    metadata: { slug: portal.slug },
  });
  return portal.toObject();
}


export async function togglePublish(projectId, userId) {
  const project = await requireOwner(projectId, userId);
  let portal = await Portal.findOne({ projectId });
  if (!portal) {
    const slug = await generateUniqueSlug(project.repoOwner, project.repoName);
    portal = await Portal.create({ projectId, slug, isPublished: true });
    ActivityLogService.log({
      userId,
      action: "PORTAL_PUBLISHED",
      projectId,
      metadata: { slug: portal.slug },
    });
    NotificationService.create({
      userId,
      type: "PORTAL_PUBLISHED",
      projectId,
      actionUrl: `/portal/${portal.slug}`,
      metadata: { projectName: project.meta?.name || project.repoName },
    });
    return portal.toObject();
  }
  portal.isPublished = !portal.isPublished;
  await portal.save();
  ActivityLogService.log({
    userId,
    action: portal.isPublished ? "PORTAL_PUBLISHED" : "PORTAL_UNPUBLISHED",
    projectId,
    metadata: { slug: portal.slug },
  });
  if (portal.isPublished) {
    NotificationService.create({
      userId,
      type: "PORTAL_PUBLISHED",
      projectId,
      actionUrl: `/portal/${portal.slug}`,
      metadata: { projectName: project.meta?.name || project.repoName },
    });
  }
  return portal.toObject();
}


export async function getPublicPortal(slug) {
  const portal = await Portal.findOne({ slug });
  if (!portal)
    throw Object.assign(new Error("Portal not found."), {
      status: 404,
      code: "NOT_FOUND",
    });
  if (!portal.isPublished)
    throw Object.assign(new Error("This portal is not public."), {
      status: 404,
      code: "NOT_FOUND",
    });


  const project = await Project.findById(portal.projectId)
    .select("repoOwner repoName meta techStack output editedOutput")
    .lean();
  if (!project)
    throw Object.assign(new Error("Project not found."), {
      status: 404,
      code: "NOT_FOUND",
    });


  const sectionVisMap = {};
  for (const s of SECTION_KEYS) sectionVisMap[s] = "public";
  for (const entry of portal.sections)
    sectionVisMap[entry.sectionKey] = entry.visibility;


  const effectiveOutput = mergeOutput(project);


  const content = {};
  for (const key of SECTION_KEYS) {
    if (sectionVisMap[key] === "internal") continue;
    content[key] =
      sectionVisMap[key] === "coming_soon" ? null : effectiveOutput[key] || "";
  }

  return {
    portal: {
      slug: portal.slug,
      isPublished: portal.isPublished,
      accessMode: portal.accessMode,
      templateId: portal.templateId || "classic",
      branding: portal.branding,
      sections: portal.sections,
      seoTitle: portal.seoTitle,
      seoDescription: portal.seoDescription,
      customDomain: portal.customDomain,
    },
    project: {
      repoOwner: project.repoOwner,
      repoName: project.repoName,
      meta: project.meta,
      techStack: project.techStack,
    },
    sectionVisibility: sectionVisMap,
    content,
  };
}


export async function verifyPortalPassword(slug, attempt) {
  const portal = await Portal.findOne({ slug }).select("+passwordHash");
  if (!portal || !portal.isPublished) return false;
  if (portal.accessMode !== "password" || !portal.passwordHash) return false;
  return bcrypt.compare(String(attempt), portal.passwordHash);
}
