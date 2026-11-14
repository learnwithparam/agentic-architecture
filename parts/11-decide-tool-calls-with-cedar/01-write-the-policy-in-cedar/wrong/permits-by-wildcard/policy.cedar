// Wrong: every agent may call every tool. One forbid blocks the filing for everyone.
permit(principal, action, resource);
forbid(principal, action == Action::"file_entry", resource);
