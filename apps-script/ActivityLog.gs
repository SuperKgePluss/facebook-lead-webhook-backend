// Activity log creation helpers for user-driven lead changes.
function createLeadStatusActivity_(leadSheet, row, oldValue, newValue) {
  const lead = getRowObject_(leadSheet, row);
  const leadId = String(lead.lead_id || '').trim();
  if (!leadId) return;

  appendObjectRow_('ACTIVITY_LOG', {
    activity_id: 'ACT-' + Date.now(),
    lead_id: leadId,
    action_type: 'lead_status_changed',
    result: String(newValue || '').trim(),
    note: 'Lead status changed from "' + String(oldValue || '') + '" to "' + String(newValue || '') + '"',
    created_by: Session.getActiveUser().getEmail() || 'Sheet user',
    created_at: new Date(),
  });
}
