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
