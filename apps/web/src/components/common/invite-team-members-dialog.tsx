import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@deco/ui/components/dialog.tsx";
import { Button } from "@deco/ui/components/button.tsx";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { z } from "zod";
import { Form, FormControl, FormField, FormItem, FormMessage } from "@deco/ui/components/form.tsx";
import { MultiSelect } from "@deco/ui/components/multi-select.tsx";
import { EmailTagsInput } from "./EmailTagsInput"; // seu componente já pronto
import { useState, useMemo, cloneElement, type MouseEventHandler, type ReactElement } from "react";
import { toast } from "@deco/ui/components/sonner.tsx";

const inviteSchema = z.object({
  emails: z.array(z.string().email("Invalid email")),
  roleId: z.array(z.string()).min(1, { message: "Select at least one role" }),
});

export function InviteTeamMembersDialog({ teamId, trigger }: { teamId: number; trigger?: React.ReactNode }) {
  const [open, setOpen] = useState(false);

  const form = useForm<{ emails: string[]; roleId: string[] }>({
    resolver: zodResolver(inviteSchema),
    defaultValues: { emails: [], roleId: [] },
  });

  const validEmails = useMemo(
    () => form.watch("emails").filter((e) => z.string().email().safeParse(e).success),
    [form.watch("emails")],
  );

  const handleInvite = async (data: { emails: string[]; roleId: string[] }) => {
    try {
      const res = await fetch(`/api/teams/${teamId}/invite`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          invitees: validEmails.map((email) => ({
            email,
            roles: data.roleId.map((id) => ({ id, name: id })),
          })),
        }),
      });

      if (!res.ok) throw new Error("Request failed");
      toast.success(`Invited ${validEmails.length} members!`);
      setOpen(false);
      form.reset();
    } catch (err) {
      console.error(err);
      toast.error("Failed to send invites");
    }
  };

  const wrappedTrigger = trigger
    ? cloneElement(trigger as ReactElement<{ onClick?: MouseEventHandler }>, {
        onClick: () => setOpen(true),
      })
    : null;

  return (
    <>
      {wrappedTrigger}
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="sm:max-w-lg">
          <DialogHeader>
            <DialogTitle>Invite members</DialogTitle>
          </DialogHeader>

          <Form {...form}>
            <form onSubmit={form.handleSubmit(handleInvite)} className="space-y-4">
              <FormField
                control={form.control}
                name="emails"
                render={({ field }) => (
                  <FormItem>
                    <FormControl>
                      <EmailTagsInput
                        emails={field.value}
                        onEmailsChange={field.onChange}
                        placeholder="Type emails separated by comma"
                      />
                    </FormControl>
                  </FormItem>
                )}
              />

              <FormField
                control={form.control}
                name="roleId"
                render={({ field }) => (
                  <FormItem>
                    <FormControl>
                      <MultiSelect
                        options={[{ label: "Collaborator", value: "collab" }, { label: "Admin", value: "admin" }]}
                        defaultValue={field.value}
                        onValueChange={field.onChange}
                        placeholder="Select roles"
                      />
                    </FormControl>
                    <FormMessage />
                  </FormItem>
                )}
              />

              <DialogFooter>
                <DialogClose asChild>
                  <Button variant="outline">Cancel</Button>
                </DialogClose>
                <Button type="submit" disabled={validEmails.length === 0}>
                  Invite {validEmails.length || ""}
                </Button>
              </DialogFooter>
            </form>
          </Form>
        </DialogContent>
      </Dialog>
    </>
  );
}
