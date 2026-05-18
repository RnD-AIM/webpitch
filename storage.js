import { createClient } from '@supabase/supabase-js';

const supabase = createClient(
    process.env.SUPABASE_URL,
    process.env.SUPABASE_ANON_KEY
);

export async function logJobStart({ jobId, url, telegramUserId, telegramUsername, telegramFirstName }) {
    const { error } = await supabase.from('webpitch_jobs').insert({
        job_id: jobId,
        url,
        telegram_user_id: telegramUserId ? String(telegramUserId) : null,
        telegram_username: telegramUsername || null,
        telegram_first_name: telegramFirstName || null,
        status: 'running',
    });
    if (error) console.warn('Supabase logJobStart error:', error.message);
}

export async function logJobComplete({ jobId, businessName, businessType, proposalUrl, emailSentTo }) {
    const { error } = await supabase.from('webpitch_jobs').update({
        business_name: businessName || null,
        business_type: businessType || null,
        proposal_url: proposalUrl || null,
        email_sent_to: emailSentTo || null,
        status: 'complete',
        completed_at: new Date().toISOString(),
    }).eq('job_id', jobId);
    if (error) console.warn('Supabase logJobComplete error:', error.message);
}

export async function logJobError({ jobId, error }) {
    const { error: dbErr } = await supabase.from('webpitch_jobs').update({
        status: 'error',
        error: String(error),
        completed_at: new Date().toISOString(),
    }).eq('job_id', jobId);
    if (dbErr) console.warn('Supabase logJobError error:', dbErr.message);
}

// Returns the most recent completed job for a given URL, or null if none exists.
export async function findCompletedJobByUrl(url) {
    const { data, error } = await supabase
        .from('webpitch_jobs')
        .select('job_id, business_name, business_type, completed_at')
        .eq('url', url)
        .eq('status', 'complete')
        .order('completed_at', { ascending: false })
        .limit(1)
        .maybeSingle();
    if (error) { console.warn('Supabase findCompletedJobByUrl error:', error.message); return null; }
    return data || null;
}

// Returns the most recent running job for a given URL, or null.
export async function findRunningJobByUrl(url) {
    const { data, error } = await supabase
        .from('webpitch_jobs')
        .select('job_id, completed_at')
        .eq('url', url)
        .eq('status', 'running')
        .limit(1)
        .maybeSingle();
    if (error) return null;
    return data || null;
}

// Returns up to `limit` recent jobs ordered newest first.
export async function listRecentJobs(limit = 10) {
    const { data, error } = await supabase
        .from('webpitch_jobs')
        .select('job_id, url, business_name, business_type, status, completed_at')
        .order('completed_at', { ascending: false, nullsFirst: true })
        .limit(limit);
    if (error) { console.warn('Supabase listRecentJobs error:', error.message); return []; }
    return data || [];
}

// Deletes the Supabase record for a job. Output directory deletion is handled by server.js.
export async function deleteJobRecord(jobId) {
    const { error } = await supabase.from('webpitch_jobs').delete().eq('job_id', jobId);
    if (error) console.warn('Supabase deleteJobRecord error:', error.message);
}
