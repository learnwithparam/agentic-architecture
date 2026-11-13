// Who may call which tool. Anything not permitted here is denied.
// Cedar denies by default, so a tool that no permit names is refused.

// The Classification agent proposes codes. It may never file an entry.
permit (principal == Agent::"classification-agent", action == Action::"list_open_shipments", resource);
permit (principal == Agent::"classification-agent", action == Action::"read_shipment", resource);
permit (principal == Agent::"classification-agent", action == Action::"lookup_tariff", resource);
permit (principal == Agent::"classification-agent", action == Action::"propose_code", resource);

// The Paperwork agent drafts entries. It files one only when a licensed broker has signed.
permit (principal == Agent::"paperwork-agent", action == Action::"list_open_shipments", resource);
permit (principal == Agent::"paperwork-agent", action == Action::"read_shipment", resource);
permit (principal == Agent::"paperwork-agent", action == Action::"search_documents", resource);
permit (principal == Agent::"paperwork-agent", action == Action::"email_importer", resource);
permit (principal == Agent::"paperwork-agent", action == Action::"read_proposals", resource);
permit (principal == Agent::"paperwork-agent", action == Action::"file_entry", resource)
when { context.brokerSigned };

// The Holds agent books exams and pays the exam fee.
permit (principal == Agent::"holds-agent", action == Action::"list_holds", resource);
permit (principal == Agent::"holds-agent", action == Action::"book_exam", resource);
permit (principal == Agent::"holds-agent", action == Action::"pay_fee", resource);
permit (principal == Agent::"holds-agent", action == Action::"check_release", resource);
