import { z } from "zod";
import {
  ForbiddenError,
  InternalServerError,
  NotFoundError,
  UserInputError,
} from "../../errors.ts";
import {
  assertPrincipalIsUser,
  assertTeamResourceAccess,
} from "../assertions.ts";
import { type AppContext, createToolGroup } from "../context.ts";
import { userFromDatabase } from "../user.ts";
import {
  checkAlreadyExistUserIdInTeam,
  enrichPlanWithTeamMetadata,
  getInviteIdByEmailAndTeam,
  getTeamById,
  insertInvites,
  sendInviteEmail,
  userBelongsToTeam,
} from "./invites-utils.ts";

/* ============================================================
   Activity Log
   ============================================================ */
export const updateActivityLog = async (
  c: AppContext,
  {
    teamId,
    userId,
    action,
  }: {
    teamId: number;
    userId: string;
    action: "add_member" | "remove_member";
  },
) => {
  const currentTimestamp = new Date().toISOString();
  const { data } = await c.db
    .from("members")
    .select("activity")
    .eq("user_id", userId)
    .eq("team_id", teamId)
    .single();

  const activityLog = data?.activity || [];

  return await c.db
    .from("members")
    .update({
      activity: [
        ...activityLog,
        {
          action,
          timestamp: currentTimestamp,
        },
      ],
    })
    .eq("team_id", teamId)
    .eq("user_id", userId);
};

/* ============================================================
   Interfaces
   ============================================================ */
export interface Role {
  id: number;
  name: string;
}
export interface InviteAPIData {
  email: string;
  id: string;
  roles: Role[];
}
const isRole = (r: any): r is Role => Boolean(r);

export interface DbMember {
  id: number;
  user_id: string | null;
  created_at: string | null;
  profiles: {
    id: string;
    name: string | null;
    email: string;
    metadata: { id: string | null; raw_user_meta_data: any };
  };
  member_roles: { roles: { id: number; name: string } }[];
}

const mapMember = ({ member_roles, ...member }: DbMember, c: AppContext) => ({
  ...member,
  user_id: member.user_id ?? "",
  created_at: member.created_at ?? "",
  profiles: userFromDatabase(member.profiles),
  roles: c.policy.filterTeamRoles(
    member_roles.map((mr) => mr.roles).filter(isRole),
  ),
});

/* ============================================================
   Tool Group
   ============================================================ */
export const createTool = createToolGroup("Team", {
  name: "Team & User Management",
  description: "Manage workspace access and roles.",
  workspace: false,
  icon: "https://assets.decocache.com/mcp/de7e81f6-bf2b-4bf5-a96c-867682f7d2ca/Team--User-Management.png",
});

/* ============================================================
   Members
   ============================================================ */
export const getTeamMembers = createTool({
  name: "TEAM_MEMBERS_GET",
  description: "Get all members of a team",
  inputSchema: z.object({ teamId: z.number(), withActivity: z.boolean().optional() }),
  handler: async (props, c) => {
    const { teamId, withActivity } = props;
    await assertTeamResourceAccess(c.tool.name, teamId, c);

    const [{ data, error }, { data: invitesData }] = await Promise.all([
      c.db.from("members").select(`
        id, user_id, admin, created_at,
        profiles!inner (id:user_id, name, email, metadata:users_meta_data_view(id, raw_user_meta_data)),
        member_roles(roles(id, name))
      `).eq("team_id", teamId).is("deleted_at", null),
      c.db.from("invites")
        .select("id, email:invited_email, roles:invited_roles")
        .eq("team_id", teamId)
        .overrideTypes<{ id: string; email: string; roles: Role[] }[]>(),
    ]);
    if (error) throw error;

    const members = data.map((m) => mapMember(m, c));
    const invites = invitesData ?? [];

    if (withActivity) {
      const { data: activityData } = await c.db
        .rpc("get_latest_user_activity", { p_resource: "team", p_key: "id", p_value: `${teamId}` })
        .select("user_id, created_at");

      const activityByUserId = activityData?.reduce((acc, a) => {
        acc[a.user_id] = a.created_at;
        return acc;
      }, {} as Record<string, string>) || {};

      return {
        members: members.map((m) => ({ ...m, lastActivity: activityByUserId[m.user_id ?? ""] })),
        invites,
      };
    }
    return { members, invites };
  },
});

/* ============================================================
   Invite Members
   ============================================================ */
export const inviteTeamMembers = createTool({
  name: "TEAM_MEMBERS_INVITE",
  description: "Invite users to join a team via email",
  inputSchema: z.object({
    teamId: z.string(),
    invitees: z.array(z.object({
      email: z.string().email(),
      roles: z.array(z.object({ id: z.number(), name: z.string() })),
    })),
  }),
  handler: async (props, c) => {
    assertPrincipalIsUser(c);
    const { teamId, invitees } = props;
    const db = c.db;
    const user = c.user;
    const teamIdAsNum = Number(teamId);

    await assertTeamResourceAccess(c.tool.name, teamIdAsNum, c);
    if (!invitees || Number.isNaN(teamIdAsNum)) throw new UserInputError("Invalid inputs");

    // Role padrão mais seguro: "collaborator"
    const processedInvitees = invitees.map((inv) =>
      !inv.roles?.length ? { ...inv, roles: [{ id: 2, name: "collaborator" }] } : inv
    );

    // Validar duplicatas
    const results = await Promise.all(processedInvitees.map(async (inv) => {
      const [invites, exists] = await Promise.all([
        getInviteIdByEmailAndTeam({ email: inv.email, teamId }, db),
        checkAlreadyExistUserIdInTeam({ email: inv.email, teamId }, db),
      ]);
      return { invitee: inv, ignore: (invites && invites.length > 0) || exists };
    }));

    const inviteesToInvite = results.filter(r => !r.ignore).map(r => r.invitee);
    if (!inviteesToInvite.length) return { message: "All users already invited or members" };

    // Get team (não checa seats em self-host)
    const teamData = await getTeamById(teamId, db);
    if (!userBelongsToTeam(teamData, user.id)) throw new ForbiddenError(`No access to team ${teamId}`);

    const invites = inviteesToInvite.map((i) => ({
      invited_email: i.email.toLowerCase(),
      team_id: teamIdAsNum,
      team_name: teamData.name,
      inviter_id: user.id,
      invited_roles: i.roles,
    }));
    const inviteResult = await insertInvites(invites, db);
    if (!inviteResult.data || inviteResult.error) throw new InternalServerError("Failed to create invites");

    // Envio de e-mails opcional
    if (process.env.SELF_HOST_MODE !== "true") {
      await Promise.all(inviteResult.data.map(async (inv) => {
        const rolesNames = (inv.invited_roles as { name: string }[]).map(r => r.name);
        await sendInviteEmail({ ...inv, inviter: user.email || "Unknown", roles: rolesNames }, c);
      }));
    } else {
      console.log("Self-host mode: invites criados sem e-mail", inviteResult.data);
    }
    return { message: `Invite created. Users can log in at https://deco.chat` };
  },
});

/* ============================================================
   Restante (updateTeamMember, removeTeamMember, acceptInvite, etc.)
   ============================================================ */
// ... (mantém seus outros handlers iguais ao que você já tem, sem checagem de seats)
