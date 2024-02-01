import type { NextApiRequest, NextApiResponse } from 'next';
import { getPrismaClient } from '@/lib/clients/prisma';
import { v4 as uuidv4 } from 'uuid';
import { Session, getServerSession } from 'next-auth';
import { authOptions } from './auth/[...nextauth]';
import { IngestQueue } from '@/jobs/queues/ingest';

interface JobParams {
    source: string;
    pdfUrl: string;
    pdfMd5Key: string;
}

interface JobNextApiRequest extends NextApiRequest {
    body: JobParams;
}
async function POST(
    req: JobNextApiRequest,
    res: NextApiResponse,
    user: Session['user']) {
    for (const key of ['source', 'pdfUrl', 'pdfMd5Key']) {
        if (!req.body[key as keyof JobParams]) {
            res.status(200).json({
                code: 500,
                message: `${key} is required`
            })
            return
        }
    }
    const { source, pdfUrl, pdfMd5Key } = req.body
    const indexName = `Index_${pdfMd5Key.replace('pdf/', '')}`
    console.log('indexName', indexName)

    try {
        const prisma = getPrismaClient()
        const documentId = uuidv4();
        const taskId = uuidv4();
        await prisma.document.create({
            data: {
                id: documentId,
                user_id: user.id,
                object_key: pdfMd5Key,
                task_id: taskId,
                index_name: indexName
            }
        })

        const queue = IngestQueue.getQueue()
        const createJobResp = await queue.createJob({
            source,
            indexName,
            pdfUrl,
            pdfMd5Key,
            taskId
        }).save()
        console.log('createJobResp', createJobResp.id)


        await prisma.task.create({
            data: {
                id: taskId,
                user_id: user.id,
                task_type: 'ingest',
                task_name: `ingest-${Date.now()}`,
                task_status: createJobResp.status,
                bq_id: createJobResp.id
            }
        })
        res.status(200).json({
            code: 200,
            data: {
                jobId: createJobResp.id,
            },
            message: `creat job success`
        })
    } catch (e) {
        res.status(200).json({
            code: 500,
            message: `creat job error: ${e}`
        })
        return
    }
}

async function DELETE(
    req: NextApiRequest,
    res: NextApiResponse,
    user: Session['user']) {
    const jobId = req.body.id as string;
    if (!jobId) {
        res.status(200).json({
            code: 500,
            message: `jobId is required`
        })
    }

    const prisma = getPrismaClient()
    const cnt = await prisma.task.count({
        where: {
            id: jobId,
            user_id: user.id
        }
    })
    if (cnt === 0) {
        res.status(200).json({
            code: 200,
            message: `job not match login user, ignore`
        })
        return
    }
    await prisma.task.delete({
        where: {
            id: jobId
        }
    })
    res.status(200).json({
        code: 200,
        message: `job deleted`
    })
}

async function GET(
    req: NextApiRequest,
    res: NextApiResponse) {
    const { jobId } = req.query
    if (!jobId) {
        res.status(200).json({
            code: 500,
            message: `jobId is required`
        })
    }
    const queue = IngestQueue.getQueue()
    const job = await queue.getJob(jobId as string)
    if (!job) {
        res.status(200).json({
            code: 500,
            message: 'job not found'
        })
        return
    }
    res.status(200).json({
        code: 200,
        data: {
            jobId: job.id,
            status: job.status,
        }
    })

}

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
    const session = await getServerSession(req, res, authOptions)
    if (!session || !session.user) {
        res.status(401)
        return
    }
    switch (req.method) {
        case 'GET':
            return GET(req, res);
        case 'POST':
            return POST(req, res, session.user);
        case 'DELETE':
            return DELETE(req, res, session.user);
        default:
            res.setHeader('Allow', ['GET', 'POST', 'DELETE']);
            res.status(405).end(`Method ${req.method} Not Allowed`);
    }
}